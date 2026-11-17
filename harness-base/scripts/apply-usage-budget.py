"""Patch ONLY an explicitly supplied isolated archive; never deploy live source.
Run after other dsh-llm patchers, before packaging/testing the staged archive.
"""
from pathlib import Path
import argparse
import os

BASE = Path(__file__).resolve().parents[1]
MARKER = '// QCODERI_USAGE_BUDGET_BOUNDARY_V1'
ANCHOR = '\t\t\t\titerator = dispatch(this.forAdapter(projectedOptions, adapter))[Symbol.asyncIterator]();'
REPLACEMENT = '''\t\t\t\t// QCODERI_USAGE_BUDGET_BOUNDARY_V1
\t\t\t\tconst qcBudgetOptions = this.forAdapter(projectedOptions, adapter);
\t\t\t\tconst qcBudgetDispatch = (request) => dispatch(request);
\t\t\t\titerator = (this.qcUsageBudgetDispatch
\t\t\t\t\t? this.qcUsageBudgetDispatch(qcBudgetOptions, qcBudgetDispatch, Object.freeze({ llm: this, modelInfo }))
\t\t\t\t\t: qcBudgetDispatch(qcBudgetOptions))[Symbol.asyncIterator]();'''
CLASS_ANCHOR = '\t\tadapters = (__runInitializers(this, _instanceExtraInitializers), /* @__PURE__ */ new Map());'
CLASS_REPLACEMENT = '\t\tusageBudgetBoundaryVersion = 1;\n' + CLASS_ANCHOR


def apply(archive):
    archive = Path(archive).resolve(strict=True)
    live = (BASE / 'source').resolve()
    staged = os.environ.get('QCODERI_STAGED_ROOT')
    staged = bool(staged and Path(staged).resolve() == BASE.parent.resolve() and (BASE.parent / 'staging-context.json').is_file())
    if (archive == live or live in archive.parents) and not staged:
        raise RuntimeError('Refusing live source: pass an isolated staged archive')
    path = archive / 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
    source = path.read_text(encoding='utf-8')
    if MARKER in source:
        provider_replacement = REPLACEMENT.replace('Object.freeze({ llm: this, modelInfo })', 'Object.freeze({ llm: this, modelInfo, providerBudgetCall })')
        if source.count(REPLACEMENT) + source.count(provider_replacement) != 1 or source.count(CLASS_REPLACEMENT) != 1:
            raise RuntimeError('Existing usage budget boundary is incomplete or changed')
    else:
        if source.count(ANCHOR) != 1 or source.count(CLASS_ANCHOR) != 1:
            raise RuntimeError('dsh-llm final dispatch anchor changed; review before patching')
        source = source.replace(ANCHOR, REPLACEMENT, 1).replace(CLASS_ANCHOR, CLASS_REPLACEMENT, 1)
    changed = []
    # Validate every input before the first write. No unrelated package/index edits.
    assets = {name: (BASE / 'assets/team' / name).read_text(encoding='utf-8')
              for name in ('usage-budget.js', 'usage-ledger.js')}
    if path.read_text(encoding='utf-8') != source:
        path.write_text(source, encoding='utf-8', newline='\n')
        changed.append(str(path))
    target = archive / 'dsh/node_modules/@qcoderi/team'
    target.mkdir(parents=True, exist_ok=True)
    for name, text in assets.items():
        dest = target / name
        if not dest.exists() or dest.read_text(encoding='utf-8') != text:
            dest.write_text(text, encoding='utf-8', newline='\n')
            changed.append(str(dest))
    print('Usage budget integration: ' + (', '.join(changed) if changed else 'already current'))
    return changed


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, help='Explicit isolated archive root containing dsh/node_modules')
    apply(parser.parse_args().archive)
