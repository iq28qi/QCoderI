"""Route source-owned team workers to their provisioned Git worktree."""
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]


def apply():
    path = BASE / 'source/dsh/node_modules/@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js'
    source = path.read_text(encoding='utf-8')
    anchor = 'meta: childSessionMeta(parent, childDepth, seed !== void 0),'
    update = '''meta: {
			...childSessionMeta(parent, childDepth, seed !== void 0),
			...seed === void 0 && typeof request[Symbol.for("qcoderi.internal.team-worktree")] === "string"
				? { cwd: request[Symbol.for("qcoderi.internal.team-worktree")] } : {}
		},'''
    if update not in source:
        if source.count(anchor) != 1:
            raise RuntimeError('Team worktree child metadata anchor changed')
        path.write_text(source.replace(anchor, update, 1), encoding='utf-8', newline='\n')
