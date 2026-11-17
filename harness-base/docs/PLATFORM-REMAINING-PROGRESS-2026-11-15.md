# QCoderI 1.3.4 — итог проверенных обязательных этапов

## Что поставлено

**Финальный локальный пакет:** `dist/verified-1.3.4/QCoderI-1.3.4-local-windows-x64.zip` — **97 227 093 байта**, SHA-256 **`dfe6d6849194a20c5c3777d92d282bcb911f57380a69ddecf9c31952b849776b`**.

Это полный EXE + Node/runtime + исходники модулей + безопасный установщик, а не один EXE без зависимостей. Все **10 519** manifest-файлов проверены; ZIP независимо прочитан и каждый файл повторно сверён по хешу. Production-подписи и публикации нет.

**Живая установка сохранена:** PID **19840**, старт **15.11.2026 15:01:46**, `G:\QCoderI\QCoderI.exe`, SHA-256 **`52af096b90f82645ac1651ee6e1c3a354a2235b8b5f5889d6ddccb13783415a1`**. Не перезапускалась, текущий агент не выгружался, live source не подменялся. Финальная версия установлена и запущена только в отдельной disposable-папке. Настоящее применение — после ручного закрытия пользователем.

## Критерии и доказательства

| Этап | Проверенный результат | Ограничения |
|---|---|---|
| Постоянный Project Brain | TF-IDF/truncated LSA vocabulary/basis/vectors на диске, гибридное ранжирование, SHA-256 свежести, строки/provenance, ограниченные возобновляемые пакеты; **9/9** | Статистическая локальная семантика, не нейронные embeddings; покрытие явно показано |
| USD/token бюджеты | Общий SQLite, атомарное резервирование, cumulative/incremental usage, uncertain holds/reconcile, human-only политика; **8/8** | Локальный admission envelope, не гарантия счёта провайдера/OS sandbox |
| Доверенный провайдер | Подготовленная capability от того же real PiAiAdapter; финальный SDK-wire endpoint/model/cap allowlist; один fetch; actual direct/prepared SDK тест прошёл | Только официальный `/v1/chat/completions`, exact `gpt-4o-mini-2024-07-18`, текст/function tools. Модель deprecated. Прокси/алиасы/другие модели запрещены при включённом бюджете |
| Исходный проект | Persisted parentSession цепочка, worktree/child/resume/fork/compaction, канонический original cwd; **18/18** | Неизвестная/сломанная/циклическая цепочка — отказ, не fallback на child cwd |
| Совместная бюджетная интеграция | Human panel → real LlmRuntime → real PiAiAdapter/OpenAI SDK → usage settlement одновременно global+original project. Unknown session и недостаток USD отклонены до transport | Fetch локальный fixture; **реальных платных вызовов не было**. Passed из полного staged **и установленного** versioned runtime |
| Замкнутая 3D evidence-приёмка | Host HMAC-run/review/import, actual image blocks, stale scene отказ, recompute, independent Blender static import; **28** применимых unit + actual Blender **1/1** | Fixture reviewer/images доказывают plumbing, не художественную красоту. UE/скелет/анимация/print без отдельных проверок остаются pending |
| Полная сборка | Offline EXE **1.3.4**, **163,41 с**, **10 519** hash-verified файлов | Не заменяет production signing |
| Установка | Настоящий полный релиз установлен в disposable root; профиль сохранён, backup/journal; installed EXE стартовал с versioned runtime; SDK import/запрос из installed runtime прошёл | Рабочая установка намеренно не менялась. Проверен отказ установщика на реально работающем fixture: EXE/profile/journal неизменны |
| UI | Реальные Brain/Budget панели и индексация; финальный1.3.4 warning проверен; новая панель в420×760 не обрезается | Общий phone-layout старого интерфейса не перерабатывался. Декоративный badge v3.2 не является версией EXE |

## Честные native-замеры

**Окончательный отчёт:** `harness-base/tests/native-startup-verified-20261115.json`, status=passed. Полная read-only копия установленной **1.3.2** против полной **1.3.4**. По3 samples для каждой версии/условия, всего12 реальных запусков.

| Условие | Baseline1.3.2 median | Candidate1.3.4 median | Изменение |
|---|---:|---:|---:|
| Новый профиль + новый EXE-процесс | **12 112,45 мс** | **12 965,79 мс** | **+7,05%**, медленнее |
| Повтор с тем же профилем | **7 155,17 мс** | **7 375,36 мс** | **+3,08%**, медленнее |

Измеряется доступный composer, ненулевые SVG bounds, декодированные изображения, а не только появление окна. В интервале12 samples CDP exceptions не обнаружены. Кеш ОС не очищался, hidden-desktop и фоновая нагрузка влияют; новый профиль не означает физически холодный диск. **Ускорение финальной сборки не подтверждено.** Эти измерения не точный UX benchmark для всех машин.

### Почему прежние проценты отозваны

Первый staging ошибочно исключал любые папки `data`, включая package-owned `node_modules/@earendil-works/pi-ai/dist/providers/data`. Manifest проверял только уже неполный набор, окно могло открыться, но actual provider import падал. Старые1.3.3 и промежуточный1.3.4 benchmark относятся к неполным baseline/candidate и **не являются окончательным сравнением**. Прежние −25%/−40% больше не заявляются.

Исправлено: dependency data сохраняется внутри `source/dsh/node_modules` и bundled runtime node_modules; приватная `harness-base/data` запрещена. Затронутые staging/installer/archive тесты повторены. Полные baseline и candidate пересняты, потому что входные runtime изменились. Неизменённые Brain/3D проверки не повторялись.

Сохранённые samples теперь связаны с **EXE и relevant runtime SHA-256**; изменение JS/Node/server запрещает reuse, даже если EXE тот же. Исторические отчёты оставлены для аудита, не используются как доказательство ускорения. После raw SSE guard повторно измерялся только изменившийся candidate;6samples неизменённого полного baseline переиспользованы с runtime identity. В измерительном скрипте устранена гонка закрытия: `quit()` может уничтожить CDP до acknowledgement, поэтому результат подтверждается выходом именно запущенного тестового процесса, не ответом уже закрытой WebView. Замеры готовности от этого не ослаблены.

## Существенная область бюджета

Консервативно резервируется **128000 входных токенов + output-cap до16384**, даже для короткого текста. Это документированный максимум принятого моделью запроса, не chars/4 и не exact tokenization. Поэтому tokenCap100000 отвергнет запрос до inference. После нормального завершения резерв заменяется adapter-reported usage. Финальный runtime проверяет **сырой SSE usage до SDK-нормализации**: missing/malformed usage не может превратиться в успешные нулевые счётчики. Требуются согласованные prompt/completion/total/cached, терминальный блок и `[DONE]`; иначе остаётся uncertain hold. Оба случая проверены настоящим SDK. Цены provider/model задаёт человек явно; неизвестная цена/usage/граница не пропускает запрос безлимитно.

Официальный источник: [GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini.md), прочитан15.11.2026. Exact snapshot помечен Deprecated; доступность не обещается. Другие endpoint/model автоматически не разрешаются. `generate_image`, standalone video/audio и прямой adapter обход вне LlmRuntime не покрыты; arbitrary filesystem/shell с доступом к ledger не является изолированным финансовым sandbox.

Подробности: `harness-base/docs/USAGE-PROVIDER-CONTRACT.md`, `USAGE-BUDGETS.md`.

## Фактические проверки и команды

- `node --test harness-base/tests/project-brain.test.mjs`:9/9 у исполнителя, неизменённый результат сохранён.
- `node --test harness-base/tests/usage-budget.test.mjs`:8/8, неизменённый ledger сохранён.
- `node --test harness-base/tests/budget-project.test.mjs`:18/18, включая real session persistence/resume/compaction.
- `node --test harness-base/tests/usage-provider.test.mjs`:actual LlmRuntime/PiAiAdapter/OpenAI SDK, cap/usage/direct/prepared/429/413/proxy/alias/tamper/media/single-fetch/idempotence; exit0. Transport fixture only.
- `HARNESS_ARCHIVE=<complete staged>/harness-base/source node harness-base/tests/usage-budget-native.mjs`:actual direct/prepared/compaction после расширения boundary, exit0.
- `QCODERI_TEST_OFFICIAL_BUDGET=1 HARNESS_ARCHIVE=<staged OR installed>/harness-base/source node harness-base/tests/workbench-budget-native.mjs`:совместная human UI/global+project/USD/SDK проверка, оба exit0.
- `node --test harness-base/tests/asset-reviews.test.mjs harness-base/tests/asset-quality.test.mjs`:28pass,2environment-opt-in skipped; отдельно `QCODERI_TEST_BLENDER=1 --test-name-pattern='real Blender factory-startup'`:actual Blender1/1. Неизменённые проверки переиспользованы.
- `cargo test --locked --offline --manifest-path harness-base/native/Cargo.toml`:3/3; native logic неизменна, версия rebuilt1.3.4.
- `python -B harness-base/tests/stage-native.test.py`:5/5 после dependency-data исправления.
- `node --test harness-base/tests/staged-native.test.mjs`:4/4 после installer path-policy исправления.
- `python -B harness-base/tests/verify-local-package.test.py`:2/2, dependency data разрешено, приватный profile/traversal запрещены.
- `node --test harness-base/tests/native-benchmark-identity.test.mjs`:2/2.
- `python -B harness-base/scripts/build.py --out harness-base/tests/.runtime/platform-candidate-20261115-v134-complete`:full offline build exit0.
- `package-local-native.py`, `verify-local-package.py`:release10519 файлов, каждый архивный файл независимо прочитан/hash verified, exit0.
- `install-staged-native.ps1 -Stage <complete candidate> -InstallRoot <disposable fixture>`:exit0; installed actual provider integration и native composer readiness exit0.
- `benchmark-native-startup.mjs <complete baseline> <complete candidate> <report> 3 both`:12samples, passed. Кандидат медленнее, честно зафиксировано.

## Применение после ручного закрытия

Распаковать ZIP **в новую папку**, не поверх работающей установки. Внутри — `README.md`, `Install-QCoderI.ps1`, `release/`.

```powershell
# Без изменения установки:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-QCoderI.ps1 -Stage "$PWD\release" -InstallRoot "G:\QCoderI" -VerifyOnly
# Только после ручного закрытия QCoderI:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-QCoderI.ps1 -Stage "$PWD\release" -InstallRoot "G:\QCoderI"
```

Установщик не останавливает/не запускает процессы, не переносит data. Runtime — `.qcoderi-releases/1.3.4/harness-base`, backup — `QCoderI.before-1.3.4.exe`, journal — `.qcoderi-local-install.json`. Проверяет прежний EXE hash; при изменившейся установке потребуется restaging. Следующий запуск вручную. Откат с закрытым приложением — вернуть backup EXE, не трогая data.

## Артефакты

- `dist/verified-1.3.4/QCoderI-1.3.4-local-windows-x64.zip`, `dist/verified-1.3.4/README.md`, `dist/verified-1.3.4/Install-QCoderI.ps1`, `dist/verified-1.3.4/local-release.json`.
- `harness-base/tests/platform-release-evidence.json` — общий machine-readable evidence.
- `native-startup-verified-20261115.json` — только это окончательное сравнение.
- `platform-budget-verified-integration.json`, `platform-budget-installed-verified.json`, `platform-package-verified.json`.
- `platform-final-budget.png`, `platform-final-budget-narrow.png`, `platform-final-budget-ui.json`, `platform-final-budget-narrow-ui.json` — настоящие финальные WebView2/UI данные.

**Единственная итоговая поставка — `dist/verified-1.3.4/` с SHA-256 в начале отчёта.** Корневые ZIP1.3.3/1.3.4 и папка `final-1.3.4/` оставлены неизменными только для аудита промежуточных результатов; не использовать их для итоговой установки.
