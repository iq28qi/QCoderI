"""Remove the upstream test notice and vendor-specific first-run modal, not CSS-hide them.
The normal Models settings, credential editor, provider catalog and licenses remain.
"""
from pathlib import Path
import json
import re

BASE = Path(__file__).resolve().parents[1]
MARKER = '// QCODERI_PROVIDER_NEUTRAL_STARTUP'


def transform(source):
    if MARKER in source:
        return source
    # These bundled regions are exclusively owned by the two first-run dialogs.
    # Anchor exactly to the modal, not the earlier Models styles.
    start = source.rfind('\t\t//#region ', 0, source.index('const css$2 = ".euLXuG_dialog'))
    end = source.index('\t\t//#region lib/types/client/operations.js', start)
    source = source[:start] + '\t\t' + MARKER + '\n' + source[end:]
    # Leave providerUsable, which is also used by the ordinary settings page.
    start = source.index('\t\t/**\n\t\t* Project first-run readiness')
    end = source.index('\t\t//#endregion', start)
    source = source[:start] + source[end:]
    start = source.index('\t\t\tconst deepSeekOnboardingInjected =')
    end = source.index('\t\t\tctx.effect(() => {', start)
    source = source[:start] + source[end:]
    source = source.replace('\t\t\t\t\twelcomeController.dispose();\n', '')
    start = source.index('\t\t\tctx.slots.inject("settings.onboarding"')
    end = source.index('\n\t\t}\n\t\t//#endregion\n\t\texports.apply', start)
    source = source[:start] + source[end:]
    source = re.sub(r'^\s*(?:welcomeTitle|welcomeBody|welcomeContinue|welcomeError|onboardingTitle|onboardingDescription|onboardingLater|onboardingSave|onboardingSaving):[^\n]*\n', '', source, flags=re.M)
    if any(name in source for name in ['WelcomeNotice', 'DeepSeekOnboardingDialog', 'welcomeController', 'onboardingReadiness']):
        raise RuntimeError('Incomplete upstream onboarding removal')
    return source


def apply(base=BASE):
    changed = []
    path = base / 'source/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js'
    source = path.read_text(encoding='utf-8')
    updated = transform(source)
    if updated != source:
        path.write_text(updated, encoding='utf-8', newline='\n')
        changed.append(path)
    # The bundled dictionary otherwise retains the removed notice's full copy.
    locale = base / 'source/dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js'
    if locale.exists():
        source = locale.read_text(encoding='utf-8')
        match = re.search(r'(const RUSSIAN_MESSAGES = )(\{[^\n]*\})(;)', source)
        if not match:
            raise RuntimeError('Russian locale dictionary anchor changed')
        messages = json.loads(match.group(2))
        stale = [key for key, value in messages.items() if any(term in key or term in str(value) for term in [
            'Internal Testing Notice', 'Harness developers', 'DSH plugin ecosystem',
            'Add an API key to get started', 'Configure the official DeepSeek provider',
            'The acknowledgement could not be saved.', 'Уведомление о тестировании',
            'QCoderI 0.1 проходит тестирование', 'Добавьте ключ API, чтобы начать',
        ])]
        for key in stale:
            del messages[key]
        if stale:
            updated = source[:match.start(2)] + json.dumps(messages, ensure_ascii=False) + source[match.end(2):]
            locale.write_text(updated, encoding='utf-8', newline='\n')
            changed.append(locale)
    return changed


if __name__ == '__main__':
    for path in apply():
        print(path)
