"""Export a bounded local inventory and optional query details from IDA.

The plugin passes the query as JSON in QCODERI_ANALYSIS_QUERY. Every value
reported here is read from the loaded database: addresses are runtime VAs of
the analyzed image (image base from ida_nalt), and pseudocode comes from
Hex-Rays only when that decompiler is actually initialized.
"""
from itertools import islice
import json
import os
import re
from pathlib import Path

import ida_auto
import ida_bytes
import ida_funcs
import ida_ida
import ida_loader
import ida_nalt
import ida_pro
import ida_segment
import ida_xref
import idautils
import idc

try:
    import ida_hexrays
except Exception:  # The decompiler module is optional in an IDA install.
    ida_hexrays = None

MAX_FUNCTIONS = 512
MAX_IMPORTS = 512
MAX_SEGMENTS = 256
MAX_INSTRUCTIONS = 1024
MAX_MATCHES = 16
MAX_CALLGRAPH_DEPTH = 3
MAX_CALLGRAPH_NODES = 32
MAX_TEXT = 12000


def normalize_query():
    query = {}
    raw = os.environ.get("QCODERI_ANALYSIS_QUERY")
    if raw:
        try:
            value = json.loads(raw)
            if isinstance(value, dict):
                query = value
        except ValueError:
            query = {}
    legacy = os.environ.get("QCODERI_ANALYSIS_FUNCTION")
    if legacy and not any(query.get(key) for key in ("function_name", "name_query", "address")):
        query["function_name"] = legacy
    return query


def bounded(query, key, default, maximum):
    try:
        value = int(query.get(key, default))
    except (TypeError, ValueError):
        return default
    return max(1, min(value, maximum))


def trim(text, limit=MAX_TEXT):
    text = str(text)
    return text if len(text) <= limit else text[:limit] + "\n... (truncated)"


def function_at(address):
    return ida_funcs.get_func(address)


def function_entry(func):
    return func.start_ea


def function_record(func):
    return dict(name=ida_funcs.get_func_name(func.start_ea),
                address=hex(func.start_ea), size=func.end_ea - func.start_ea)


def resolve_address(text, image_base, is_offset):
    """Accept 0x-prefixed or bare hex, optionally an RVA from the image base."""
    value = int(str(text).strip(), 16)
    if is_offset:
        value += image_base
    return value


def decompile(address):
    if ida_hexrays is None:
        return dict(available=False, reason="Модуль Hex-Rays отсутствует в этой установке IDA.")
    try:
        if not ida_hexrays.init_hexrays_plugin():
            return dict(available=False, reason="Hex-Rays не инициализирован: нет лицензии или поддержки декомпилятора.")
        cfunc = ida_hexrays.decompile(address)
        if cfunc is None:
            return dict(available=False, reason="Декомпилятор не вернул результат для этой функции.")
        return dict(available=True, language="Hex-Rays", code=trim(str(cfunc)))
    except Exception as error:  # A failed decompile must not lose the inventory.
        return dict(available=False, reason="Ошибка декомпилятора: %s" % error)


def instructions_of(func, limit):
    items = (address for address in idautils.FuncItems(func.start_ea)
             if ida_bytes.is_code(ida_bytes.get_full_flags(address)))
    listing = [dict(address=hex(address), text=idc.GetDisasm(address))
               for address in islice(items, limit + 1)]
    truncated = len(listing) > limit
    return listing[:limit], truncated


def callers_of(func):
    callers = []
    for xref in idautils.XrefsTo(func.start_ea, ida_xref.XREF_ALL):
        caller = ida_funcs.get_func(xref.frm)
        callers.append(dict(
            address=hex(xref.frm),
            function=ida_funcs.get_func_name(caller.start_ea) if caller else None,
            function_address=hex(caller.start_ea) if caller else None,
            kind="call" if xref.iscode else "data",
            target=hex(xref.to),
        ))
        if len(callers) >= 256:
            break
    return callers


def callees_of(func):
    seen = {}
    for item in idautils.FuncItems(func.start_ea):
        for target in idautils.CodeRefsFrom(item, 0):
            callee = ida_funcs.get_func(target)
            if not callee:
                continue
            entry = callee.start_ea
            record = seen.setdefault(entry, dict(name=ida_funcs.get_func_name(entry), address=hex(entry),
                                                call_sites=[]))
            site = hex(item)
            if site not in record["call_sites"] and len(record["call_sites"]) < 16:
                record["call_sites"].append(site)
            if len(seen) >= 256:
                return list(seen.values())
    return list(seen.values())


def callgraph(root, depth):
    nodes = []
    seen = {root.start_ea}
    frontier = [(root, 0)]
    while frontier and len(nodes) < MAX_CALLGRAPH_NODES:
        func, level = frontier.pop(0)
        callees = callees_of(func) if level < depth else []
        nodes.append(dict(name=ida_funcs.get_func_name(func.start_ea), address=hex(func.start_ea),
                          depth=level,
                          callees=[dict(name=entry["name"], address=entry["address"]) for entry in callees]))
        for entry in callees:
            address = int(entry["address"], 16)
            if address in seen or len(seen) >= MAX_CALLGRAPH_NODES:
                continue
            seen.add(address)
            nested = ida_funcs.get_func(address)
            if nested:
                frontier.append((nested, level + 1))
    return dict(depth=depth, nodes=nodes, truncated=bool(frontier))


def match_functions(query, image_base):
    """Resolve the requested functions, keeping the query echo for the report."""
    limit = bounded(query, "matches", 4, MAX_MATCHES)
    found = []
    seen = set()

    def add(func, reason):
        if not func or func.start_ea in seen or len(found) >= limit:
            return
        seen.add(func.start_ea)
        found.append((function_record(func), reason))

    if query.get("address"):
        address = resolve_address(query["address"], image_base, query.get("address_is_offset") is True)
        add(function_at(address), "address")
    if query.get("function_name"):
        for ea in idautils.Functions():
            if ida_funcs.get_func_name(ea) == query["function_name"]:
                add(ida_funcs.get_func(ea), "function_name")
                break
    if query.get("name_query"):
        pattern = None
        if query.get("regex"):
            try:
                pattern = re.compile(query["name_query"])
            except re.error:
                pattern = None
        needle = query["name_query"].lower()
        for ea in idautils.Functions():
            name = ida_funcs.get_func_name(ea)
            matched = bool(pattern.search(name)) if pattern else needle in name.lower()
            if matched:
                add(ida_funcs.get_func(ea), "name_query")
            if len(found) >= limit:
                break
    return found


def string_matches(text, limit):
    matches = []
    needle = text.lower()
    if not needle:
        return matches
    try:
        for item in idautils.Strings():
            value = str(item)
            if needle in value.lower():
                matches.append(dict(address=hex(item.ea), value=trim(value, 512)))
            if len(matches) >= limit:
                break
    except Exception as error:
        matches.append(dict(error="Список строк недоступен: %s" % error))
    return matches


def inventory(query):
    if not ida_auto.auto_wait():
        raise RuntimeError("IDA analysis was cancelled")
    image_base = ida_nalt.get_imagebase()
    sections = []
    for address in islice(idautils.Segments(), MAX_SEGMENTS):
        segment = ida_segment.getseg(address)
        sections.append(dict(
            name=ida_segment.get_segm_name(segment), address=hex(address),
            size=segment.end_ea - segment.start_ea, read=bool(segment.perm & 4),
            write=bool(segment.perm & 2), execute=bool(segment.perm & 1),
        ))
    imports = []
    for index in range(ida_nalt.get_import_module_qty()):
        library = ida_nalt.get_import_module_name(index)

        def add_import(address, name, ordinal):
            imports.append(dict(name=name, library=library, address=hex(address), ordinal=ordinal))
            return len(imports) < MAX_IMPORTS

        ida_nalt.enum_import_names(index, add_import)
        if len(imports) >= MAX_IMPORTS:
            break
    report = dict(
        engine="ida", format=ida_loader.get_file_type_name(), architecture=ida_ida.inf_get_procname(),
        image_base=hex(image_base), analysis_complete=True,
        sections=sections, function_count=ida_funcs.get_func_qty(),
        functions=[dict(name=ida_funcs.get_func_name(ea), address=hex(ea),
                        size=ida_funcs.calc_func_size(ida_funcs.get_func(ea)))
                   for ea in islice(idautils.Functions(), MAX_FUNCTIONS)],
        imports=imports,
    )
    if not any(query.get(key) for key in ("function_name", "name_query", "address", "strings_query")):
        return report
    report["query"] = query
    report["address_convention"] = "hex VA внутри загруженного образа; image_base указан отдельно"
    instruction_limit = bounded(query, "instruction_limit", 128, MAX_INSTRUCTIONS)
    details = []
    for record, reason in match_functions(query, image_base):
        func = function_at(int(record["address"], 16))
        listing, truncated = instructions_of(func, instruction_limit)
        detail = dict(record)
        detail.update(matched_by=reason, instruction_count=len(listing),
                      instructions=listing, truncated=truncated)
        if query.get("xrefs") is not False:
            detail["callers"] = callers_of(func)
            detail["callees"] = callees_of(func)
        if query.get("decompile"):
            detail["decompiled"] = decompile(func.start_ea)
        depth = bounded(query, "callgraph_depth", 0, MAX_CALLGRAPH_DEPTH) if query.get("callgraph_depth") else 0
        if depth:
            detail["callgraph"] = callgraph(func, depth)
        details.append(detail)
    report["function_details"] = details
    if query.get("strings_query"):
        report["string_matches"] = string_matches(query["strings_query"],
                                                   bounded(query, "string_limit", 32, 256))
    return report


def main():
    query = normalize_query()
    report = inventory(query)
    Path(os.environ["QCODERI_ANALYSIS_REPORT"]).write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


try:
    main()
except Exception:
    import traceback
    traceback.print_exc()
    ida_pro.qexit(1)
else:
    ida_pro.qexit(0)