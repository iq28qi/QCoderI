# QCoderI: запуск, автономность и основа 3D Quality Engine

## Границы работы

Изменены исходники и проверены изолированные сценарии. Текущий QCoderI, агент и
рабочая история этим процессом разработки не перезапускались и не перезагружались.
Полная сборка/установка EXE в этой работе не выполнялась. Изменения уже загруженных
модулей действующего процесса требуют следующего ручного запуска; горячая подмена
работающего агента намеренно не выполнялась.

Запрошенная большая платформа не объявляется полностью реализованной. Ниже —
реальный проверенный набор и явные ограничения.

## Что изменено

### Запуск и иконки

- 18 SVG-символов встроены в HTML до React root; sidebar/session используют
  document-local ссылки, а не отдельный sprite-запрос.
- Ленивый ограниченный кеш статики с ETag/304, MIME, 404, инвалидацией и проверкой
  выхода по симлинкам; HTML, API, credentials и история не кешируются.
- Необязательный Node bytecode cache до динамического импорта host.
- Сохранены capability/origin, CSP и свежая инъекция профиля.
- Runtime helper находится в `source/dsh/qcoderi-startup-cache.mjs`, чтобы оставаться
  внутри существующего allowlist подписанных обновлений. Сборщик копирует его из
  `native/startup-cache.mjs` и включает в контрольные суммы.
- Сборка устанавливает все source-owned team helper-модули, а не устаревающий
  жёсткий список имён; тестовый browser profile исключён из legacy ASAR.

Фактический HTTP fixture: 5996 байт тела первого ответа → 0 при 304.
В отдельном интегрированном интерфейсе с чистым профилем и заблокированным HTTPS:
14 sidebar/session SVG найдены, имеют геометрию; нет внешних запросов, ошибок
ресурсов и uncaught renderer exceptions. Полный cold-start Windows/WebView2
не профилировался: процент ускорения не заявляется. Остаются крупный plugin bundle
и ожидание host до создания native window.

### Удаление upstream-уведомлений

По прямому уточнению пользователя удалены из исполняемого client bundle:
компоненты WelcomeNotice и DeepSeekOnboardingDialog, их стили/store, регистрация,
копия текста и ненужное чтение acknowledgement. Устаревший текст убран из русской
локализации. Не используется CSS-скрытие или автоматическое согласие.

Сохранены ModelsSection, custom providers, discovery и credential editor.
Патч `scripts/remove-upstream-onboarding.py` вызывается сборкой и идемпотентен.
Smoke/performance сценарии больше не требуют нажимать старые стартовые кнопки.
Юридические лицензии и совместимые внутренние имена зависимостей не удалялись.

### Автономность и Git-изоляция

- `repair_attempts`: 0–2 автоматических исправления после обычного ненулевого кода
  проверки; исполнитель получает конкретный вывод теста.
- Отмена, policy/runner failure и тайм-аут не запускают слепой repair.
- Состояние, история и счётчики сохраняются атомарно; resume не обнуляет бюджет
  автоматических исправлений и не повторяет уже завершённые задачи.
- Прерванная проверка может продолжиться без нового worker. Пауза ждёт освобождения
  исполнителей; `budget_seconds` ограничивает время одного запуска команды.
- Настраиваемая модель каждого задания, согласованное чтение/запись и ресурсы.
- `workspace_mode: git_worktree` работает из чистого закоммиченного репозитория;
  реальные агенты и проверки получают отдельные cwd. Результат интегрируется в
  отдельную ветку `codex/qcoderi-team-*`, не в пользовательский checkout.
  Конфликт сохраняется для разбора, исходные незакоммиченные изменения не затираются.

Git worktree — изоляция рабочих копий, не OS sandbox. Денежный/токенный бюджет
здесь не реализован; временной бюджет не следует выдавать за контроль стоимости.

### Память проекта

Проверены долговременное хранение решений с источником, ревизии, релевантность,
исключение истёкших записей и настоящая сборка контекста AgentLoop.
`project_context` возвращает текущие строки кода и пути ассетов с явным coverage,
лимитами и флагом неполного результата. Из поиска исключены известные секреты,
личный профиль, зависимости, backups и ссылки. Это эвристическая фильтрация,
не гарантия DLP. Бинарные ассеты помечаются `inspected: false`.
Полный постоянный семантический индекс проекта не реализован.

### 3D Quality Engine

- `asset_specification` v1: точные subjects, назначение, единицы, требования и лимиты.
- Геометрия анализируется и до, и после модификаторов; размеры — в мировых метрах,
  бюджет — в evaluated triangles. Проверяются измеримые свойства материалов,
  сетки, UV и весов согласно требованиям.
- Каждый запуск сохраняет `asset-specification.json`, `quality.json`,
  `evidence.json`, scene/inspection и привязку к входным файлам.
- Gates: pass/fail/pending/not_applicable; ошибки содержат конкретные defects.
- Сохранённый .blend, один PNG или записанный FBX не засчитывают независимую
  визуальную проверку, проверку деформации или импорт в UE.

В текущей реализации такие отзывы пока не связываются автоматически с quality.json:
применимые gates остаются pending, `ready_for_export=false`. Это осознанное
ограничение, а не полностью замкнутый профессиональный production pipeline.
Автоматические ретопология, лицевой риг, lip sync и художественная корректность
не заявляются готовыми.

## Фактически выполненные проверки

Рабочий каталог команд: `G:\QCoderI`.

```powershell
# 13 проверок иконок/кеша + 4 удаления upstream-onboarding: 17/17.
& .\harness-base\app\resources\runtime\node\node.exe --test `
  harness-base/tests/provider-neutral-startup.test.mjs `
  harness-base/tests/startup-performance.test.mjs

# Scheduler, durable autonomy, реальный Git merge и asset gates:
# 46 passed, 1 явно skipped (real Blender opt-in). Opt-in затем выполнен ниже.
& .\harness-base\app\resources\runtime\node\node.exe --test `
  harness-base/tests/provider-neutral-startup.test.mjs `
  harness-base/tests/team.test.mjs harness-base/tests/team-autonomy.test.mjs `
  harness-base/tests/git-team-worktrees.test.mjs harness-base/tests/asset-quality.test.mjs

# Реальные bpy/сохранение/повторная инспекция и 24 проверки fixture: 12/12.
$env:QCODERI_TEST_BLENDER='1'
& .\harness-base\app\resources\runtime\node\node.exe --test harness-base/tests/asset-quality.test.mjs

# Реальный AgentLoop/Tools/Jobs с локальным scripted model transport, без оплаты.
& .\harness-base\app\resources\runtime\node\node.exe harness-base/scripts/test-next-runtime.mjs `
  team-native.mjs workbench-native.mjs chat-native.mjs

# Дополнительно выполнены managed check runner и реальный Blender repair turn.
& .\harness-base\app\resources\runtime\node\node.exe harness-base/scripts/test-next-runtime.mjs `
  team-native.mjs team-checks.test.mjs studio3d-native.mjs

# Три проверки сборочной интеграции в disposable source tree.
python harness-base/tests/build-runtime.test.py

# Изолированный UI с собственным профилем, не живое окно QCoderI.
& .\harness-base\app\resources\runtime\node\node.exe harness-base/scripts/preview-next-ui.mjs
& .\harness-base\app\resources\runtime\node\node.exe harness-base/scripts/inspect-next-ui.mjs --after
```

Финальный общий прогон неизменившегося кода: **61/61 passed, 0 skipped**, включая
startup/onboarding, scheduler/autonomy/worktrees, project-context/workbench,
image input/policy, stream-publication, request-recovery и visual-workflow.
`build-runtime.test.py`: **3/3**, `node --check native/desktop-server.mjs`: exit 0.
После последующих изменений только документации эти тесты не повторялись.

Оставшийся пользовательский путь проверен отдельно:
`scripts/inspect-next-models.mjs`: реальный переход «Модели» → «Добавить своего
провайдера», доступные поля endpoint/API-ключа/моделей; root не inert, renderer
exceptions и внешние запросы отсутствуют. Профиль тестовый, credentials и настройки
не сохранялись. Настоящие скриншоты обоих состояний показаны в чате.

Финальная независимая read-only команда из двух проверяющих была запущена по
просьбе пользователя. Обе задачи достигли установленного лимита 400 с без итогового
отчёта; это **не успешное независимое ревью**. Файлы ими не менялись, тесты не
дублировались. Повторная команда не запускалась. Финальная сверка ведущего опирается
на просмотренный код, перечисленные успешные тесты и фактические UI-артефакты.

Артефакты:
- `harness-base/tests/startup-isolated-after.json` — реальный DOM/network/glyph report.
- `harness-base/tests/startup-no-upstream-notice.png` — снимок отдельного тестового окна.
- `harness-base/tests/provider-neutral-models-ui.json` — фактический DOM/ошибки и
  доступность редактора своего провайдера после удаления onboarding.
- `harness-base/tests/.runtime/next-runtime-2alCDQ/results.json` — финальные AgentLoop проверки.
- `harness-base/tests/.runtime/asset-quality-JaeqQA/QCoderI-3D/run-Uzt0tr/quality.json`
  — technical_status=pass, общий status=pending, ready_for_export=false.
- Соседние `fixture-results.json` и `evidence.json` — реальные bpy-проверки и хеши.

В Blender repair fixture измерена ошибка центральных RGB-пикселей 31.09 → 0.00,
loose vertex 1 → 0 и восстановление WrongRed → SatinMetal. Это детерминированный
технический сценарий, не оценка качества произвольной 3D-модели и не результат
платного художественного критика.

## Следующие независимые этапы

1. Связать подтверждённые visual/reference/deformation/export reviews с хешами
   конкретной версии сцены и машинными gates; не принимать произвольные pass-флаги.
2. Постоянный incremental Project Brain с provenance, stale-инвалидацией и
   политикой приватности, без тяжёлого полного сканирования при старте.
3. Бюджеты стоимости/токенов, очередь после перезапуска и явная политика
   возобновления внешних действий без их дублирования.
4. Lazy/split загрузка plugin bundle с отдельным cold/warm benchmark WebView2.
5. Расширения MCP/remote workers/browser DOM/debugger и специализированные 3D
   операции — отдельные проверяемые интеграции, не готовые функции этой поставки.
