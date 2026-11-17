"""Record real native boot stages while retaining the desktop host composition."""
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]


def apply():
    path = BASE / 'source/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'
    source = path.read_text(encoding='utf-8')
    changes = (
        ('const composition = desktopComposition(absoluteRuntime, absoluteProject, options.allowLinkedPackages === true);',
         'options.onStartupPhase?.("разрешение зависимостей профиля");\n\t'),
        ('const ctx = await boot("dsh desktop", rootConfig, structuredClone(composition.patches), async (hostCtx) => {',
         'options.onStartupPhase?.("загрузка модулей и сервисов");\n\t'),
        ('const connection = ctx.get("connection");',
         'options.onStartupPhase?.("подготовка интерфейса");\n\t'),
    )
    for anchor, addition in changes:
        if addition + anchor in source:
            continue
        if source.count(anchor) != 1:
            raise RuntimeError('Desktop boot stage changed, review instrumentation: ' + anchor)
        source = source.replace(anchor, addition + anchor, 1)
    if source != path.read_text(encoding='utf-8'):
        path.write_text(source, encoding='utf-8', newline='\n')


if __name__ == '__main__':
    apply()
