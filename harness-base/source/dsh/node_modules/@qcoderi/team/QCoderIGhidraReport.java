import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

import com.google.gson.GsonBuilder;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.util.headless.HeadlessScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.Symbol;

/**
 * Export a bounded local inventory and optional query details from Ghidra.
 *
 * Addresses are VAs of the analyzed program in hex; the image base is reported
 * separately. Pseudocode comes from Ghidra's own decompiler for the loaded
 * program, so every claim in the report can be re-checked in this database.
 */
public class QCoderIGhidraReport extends HeadlessScript {
    private static final int MAX_FUNCTIONS = 512;
    private static final int MAX_IMPORTS = 512;
    private static final int MAX_SECTIONS = 256;
    private static final int MAX_INSTRUCTIONS = 1024;
    private static final int MAX_MATCHES = 16;
    private static final int MAX_CALLGRAPH_DEPTH = 3;
    private static final int MAX_CALLGRAPH_NODES = 32;
    private static final int MAX_TEXT = 12000;
    private static final int MAX_REFERENCE_SCAN = 4096;
    private static final int MAX_STRING_SCAN = 200000;

    private Map<String, Object> query = new LinkedHashMap<>();

    @Override
    public void run() throws Exception {
        query = readQuery();
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("engine", "ghidra");
        report.put("format", currentProgram.getExecutableFormat());
        report.put("architecture", currentProgram.getLanguageID().toString());
        report.put("image_base", currentProgram.getImageBase().toString());
        report.put("analysis_complete", !analysisTimeoutOccurred());

        List<Map<String, Object>> sections = new ArrayList<>();
        for (MemoryBlock block : currentProgram.getMemory().getBlocks()) {
            if (sections.size() == MAX_SECTIONS) break;
            Map<String, Object> section = new LinkedHashMap<>();
            section.put("name", block.getName());
            section.put("address", block.getStart().toString());
            section.put("size", block.getSize());
            section.put("read", block.isRead());
            section.put("write", block.isWrite());
            section.put("execute", block.isExecute());
            sections.add(section);
        }
        report.put("sections", sections);

        var functions = currentProgram.getFunctionManager();
        report.put("function_count", functions.getFunctionCount());
        List<Map<String, Object>> samples = new ArrayList<>();
        for (Function function : functions.getFunctions(true)) {
            if (samples.size() == MAX_FUNCTIONS) break;
            monitor.checkCancelled();
            samples.add(functionRecord(function));
        }
        report.put("functions", samples);

        List<Map<String, Object>> imports = new ArrayList<>();
        var symbols = currentProgram.getSymbolTable().getExternalSymbols();
        while (symbols.hasNext() && imports.size() < MAX_IMPORTS) {
            Symbol symbol = symbols.next();
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", symbol.getName());
            entry.put("namespace", symbol.getParentNamespace().getName());
            imports.add(entry);
        }
        report.put("imports", imports);

        if (!queried()) {
            write(report);
            return;
        }
        report.put("query", query);
        report.put("address_convention", "hex VA внутри загруженного образа; image_base указан отдельно");
        report.put("function_details", details());
        if (text("strings_query") != null) {
            report.put("string_matches", stringMatches(text("strings_query"), integer("string_limit", 32, 256)));
        }
        write(report);
    }

    private void write(Map<String, Object> report) throws Exception {
        Files.writeString(Path.of(getScriptArgs()[0]),
            new GsonBuilder().setPrettyPrinting().create().toJson(report));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readQuery() {
        Map<String, Object> parsed = new LinkedHashMap<>();
        String raw = System.getenv("QCODERI_ANALYSIS_QUERY");
        if (raw != null && !raw.isBlank()) {
            try {
                Object value = new com.google.gson.Gson().fromJson(raw, Object.class);
                if (value instanceof Map) parsed.putAll((Map<String, Object>) value);
            } catch (RuntimeException ignored) {
                // A malformed query must not lose the inventory report.
            }
        }
        String legacy = System.getenv("QCODERI_ANALYSIS_FUNCTION");
        if (legacy != null && !legacy.isBlank()
            && text("function_name") == null && text("name_query") == null && text("address") == null) {
            parsed.put("function_name", legacy);
        }
        return parsed;
    }

    private boolean queried() {
        return text("function_name") != null || text("name_query") != null
            || text("address") != null || text("strings_query") != null;
    }

    private String text(String key) {
        Object value = query.get(key);
        return value instanceof String && !((String) value).isBlank() ? (String) value : null;
    }

    private boolean flag(String key, boolean fallback) {
        Object value = query.get(key);
        return value instanceof Boolean ? (Boolean) value : fallback;
    }

    private int integer(String key, int fallback, int maximum) {
        Object value = query.get(key);
        int parsed = fallback;
        if (value instanceof Number) parsed = ((Number) value).intValue();
        else if (value instanceof String) {
            try { parsed = Integer.parseInt((String) value); }
            catch (NumberFormatException ignored) { parsed = fallback; }
        }
        return Math.max(0, Math.min(parsed, maximum));
    }

    private Map<String, Object> functionRecord(Function function) {
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("name", function.getName());
        record.put("address", function.getEntryPoint().toString());
        record.put("size", function.getBody().getNumAddresses());
        return record;
    }

    private Address address(String value, boolean isOffset) {
        long offset = Long.parseUnsignedLong(value.replaceFirst("^0[xX]", "").trim(), 16);
        if (isOffset) offset += currentProgram.getImageBase().getOffset();
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(offset);
    }

    private List<Map<String, Object>> details() throws Exception {
        int limit = Math.max(1, integer("matches", 4, MAX_MATCHES));
        int instructionLimit = Math.max(1, integer("instruction_limit", 128, MAX_INSTRUCTIONS));
        int depth = integer("callgraph_depth", 0, MAX_CALLGRAPH_DEPTH);
        List<Map<String, Object>> found = new ArrayList<>();
        Set<Long> seen = new LinkedHashSet<>();

        if (text("address") != null) {
            Address target = address(text("address"), flag("address_is_offset", false));
            Function function = currentProgram.getFunctionManager().getFunctionContaining(target);
            if (function == null) function = currentProgram.getFunctionManager().getFunctionAt(target);
            addFunction(found, seen, function, "address", limit);
        }
        if (text("function_name") != null) {
            for (Function function : currentProgram.getFunctionManager().getFunctions(true)) {
                if (function.getName().equals(text("function_name"))) {
                    addFunction(found, seen, function, "function_name", limit);
                    break;
                }
            }
        }
        String nameQuery = text("name_query");
        if (nameQuery != null) {
            Pattern pattern = null;
            if (flag("regex", false)) {
                try { pattern = Pattern.compile(nameQuery); }
                catch (PatternSyntaxException ignored) { pattern = null; }
            }
            String needle = nameQuery.toLowerCase();
            for (Function function : currentProgram.getFunctionManager().getFunctions(true)) {
                if (found.size() >= limit) break;
                boolean matched = pattern != null
                    ? pattern.matcher(function.getName()).find()
                    : function.getName().toLowerCase().contains(needle);
                if (matched) addFunction(found, seen, function, "name_query", limit);
            }
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (Map<String, Object> record : found) {
            Function function = currentProgram.getFunctionManager()
                .getFunctionAt(currentProgram.getAddressFactory().getDefaultAddressSpace()
                    .getAddress(Long.parseUnsignedLong(((String) record.get("address")).replaceFirst("^0[xX]", ""), 16)));
            if (function == null) continue;
            monitor.checkCancelled();
            Map<String, Object> detail = new LinkedHashMap<>(record);
            List<Map<String, Object>> instructions = instructions(function, instructionLimit + 1);
            boolean truncated = instructions.size() > instructionLimit;
            if (truncated) instructions = instructions.subList(0, instructionLimit);
            detail.put("instruction_count", instructions.size());
            detail.put("instructions", instructions);
            detail.put("truncated", truncated);
            if (flag("xrefs", true)) {
                detail.put("callers", callers(function));
                detail.put("callees", callees(function));
            }
            if (flag("decompile", false)) detail.put("decompiled", decompile(function));
            if (depth > 0) detail.put("callgraph", callgraph(function, depth));
            result.add(detail);
        }
        return result;
    }

    private void addFunction(List<Map<String, Object>> found, Set<Long> seen,
            Function function, String reason, int limit) {
        if (function == null || found.size() >= limit) return;
        long entry = function.getEntryPoint().getOffset();
        if (!seen.add(entry)) return;
        Map<String, Object> record = functionRecord(function);
        record.put("matched_by", reason);
        found.add(record);
    }

    private List<Map<String, Object>> instructions(Function function, int limit) throws Exception {
        List<Map<String, Object>> listing = new ArrayList<>();
        var iterator = currentProgram.getListing().getInstructions(function.getBody(), true);
        while (iterator.hasNext() && listing.size() < limit) {
            monitor.checkCancelled();
            Instruction instruction = iterator.next();
            Map<String, Object> record = new LinkedHashMap<>();
            record.put("address", instruction.getAddress().toString());
            record.put("text", instruction.toString());
            listing.add(record);
        }
        return listing;
    }

    private List<Map<String, Object>> callers(Function function) {
        List<Map<String, Object>> callers = new ArrayList<>();
        ReferenceIterator references =
            currentProgram.getReferenceManager().getReferencesTo(function.getEntryPoint());
        int scanned = 0;
        while (references.hasNext() && scanned++ < MAX_REFERENCE_SCAN && callers.size() < 256) {
            Reference reference = references.next();
            Function caller = currentProgram.getFunctionManager()
                .getFunctionContaining(reference.getFromAddress());
            Map<String, Object> record = new LinkedHashMap<>();
            record.put("address", reference.getFromAddress().toString());
            record.put("function", caller == null ? null : caller.getName());
            record.put("function_address", caller == null ? null : caller.getEntryPoint().toString());
            record.put("kind", reference.getReferenceType().isCall() ? "call" : "data");
            callers.add(record);
        }
        return callers;
    }

    private List<Map<String, Object>> callees(Function function) throws Exception {
        List<Map<String, Object>> callees = new ArrayList<>();
        for (Function callee : function.getCalledFunctions(monitor)) {
            if (callees.size() >= 256) break;
            Map<String, Object> record = new LinkedHashMap<>();
            record.put("name", callee.getName());
            record.put("address", callee.getEntryPoint().toString());
            callees.add(record);
        }
        return callees;
    }

    private Map<String, Object> callgraph(Function root, int depth) throws Exception {
        List<Map<String, Object>> nodes = new ArrayList<>();
        Set<Long> seen = new LinkedHashSet<>();
        List<Object[]> frontier = new ArrayList<>();
        frontier.add(new Object[]{root, 0});
        seen.add(root.getEntryPoint().getOffset());
        while (!frontier.isEmpty() && nodes.size() < MAX_CALLGRAPH_NODES) {
            Object[] item = frontier.remove(0);
            Function function = (Function) item[0];
            int level = (Integer) item[1];
            monitor.checkCancelled();
            List<Map<String, Object>> edges = new ArrayList<>();
            if (level < depth) {
                for (Function callee : function.getCalledFunctions(monitor)) {
                    Map<String, Object> edge = new LinkedHashMap<>();
                    edge.put("name", callee.getName());
                    edge.put("address", callee.getEntryPoint().toString());
                    edges.add(edge);
                    long entry = callee.getEntryPoint().getOffset();
                    if (seen.add(entry) && nodes.size() + frontier.size() < MAX_CALLGRAPH_NODES) {
                        frontier.add(new Object[]{callee, level + 1});
                    }
                }
            }
            Map<String, Object> node = new LinkedHashMap<>();
            node.put("name", function.getName());
            node.put("address", function.getEntryPoint().toString());
            node.put("depth", level);
            node.put("callees", edges);
            nodes.add(node);
        }
        Map<String, Object> graph = new LinkedHashMap<>();
        graph.put("depth", depth);
        graph.put("nodes", nodes);
        graph.put("truncated", !frontier.isEmpty());
        return graph;
    }

    private Map<String, Object> decompile(Function function) {
        DecompInterface decompiler = new DecompInterface();
        Map<String, Object> result = new LinkedHashMap<>();
        try {
            if (!decompiler.openProgram(currentProgram)) {
                result.put("available", false);
                result.put("reason", "Декомпилятор не открыл программу.");
                return result;
            }
            DecompileResults decompiled = decompiler.decompileFunction(function, 60, monitor);
            if (decompiled == null || !decompiled.decompileCompleted()
                || decompiled.getDecompiledFunction() == null) {
                result.put("available", false);
                result.put("reason", decompiled == null ? "Декомпилятор не вернул результат."
                    : decompiled.getErrorMessage());
                return result;
            }
            String code = decompiled.getDecompiledFunction().getC();
            result.put("available", true);
            result.put("language", "Ghidra decompiler");
            result.put("code", code.length() > MAX_TEXT ? code.substring(0, MAX_TEXT) + "\n... (truncated)" : code);
            return result;
        } catch (Exception error) {
            result.put("available", false);
            result.put("reason", "Ошибка декомпилятора: " + error.getMessage());
            return result;
        } finally {
            decompiler.dispose();
        }
    }

    private List<Map<String, Object>> stringMatches(String needle, int limit) {
        List<Map<String, Object>> matches = new ArrayList<>();
        String lowered = needle.toLowerCase();
        var iterator = currentProgram.getListing().getDefinedData(true);
        int scanned = 0;
        while (iterator.hasNext() && scanned++ < MAX_STRING_SCAN && matches.size() < limit) {
            Data data = iterator.next();
            if (!data.hasStringValue()) continue;
            String value;
            try { value = String.valueOf(data.getValue()); }
            catch (RuntimeException ignored) { continue; }
            if (value.toLowerCase().contains(lowered)) {
                Map<String, Object> record = new LinkedHashMap<>();
                record.put("address", data.getAddress().toString());
                record.put("value", value.length() > 512 ? value.substring(0, 512) : value);
                matches.add(record);
            }
        }
        return matches;
    }
}