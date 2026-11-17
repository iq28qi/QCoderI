# Узкий доверенный провайдерный budget-contract

## Что поддержано

Только **точный** `gpt-4o-mini-2024-07-18`, protocol `openai-completions`, base URL **строго** `https://api.openai.com/v1`, конечный POST `/chat/completions`. Название provider route может быть пользовательским, но endpoint/model проверяются по фактическому prepared snapshot и повторно на wire. Прокси, алиасы, Responses/Anthropic, reasoning-модели, image/audio/video и дополнительные платные сервисы не получают эту capability.

Официальный источник: [GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini.md), прочитан 15.11.2026. Он документирует context window **128 000**, output maximum **16 384**, exact snapshot. Модель на момент проверки помечена **Deprecated**: контракт не гарантирует доступность у провайдера. Другие модели автоматически не разрешаются.

## Какой это предел

Резервируется **весь максимум входа успешно принятого моделью запроса** 128 000 токенов, плюс принудительный output-cap (до 16 384). Это консервативный capacity envelope, **не chars/4, не точный tokenizer, не значение из изменяемого model catalog**. Вход большей длины должен быть отклонён официальным API, а не успешно выполнен; это явно внешнее допущение о документированном API. Счёт провайдера, сторонние сервисы и нарушающий контракт сервер локально гарантировать нельзя.

Следствие: tokenCap=100000 отклонит даже короткий запрос до inference. Для одного обычного запроса нужен свободный резерв минимум 128000+output-cap. После завершения реальный adapter-reported usage заменяет резерв. Цена задаётся человеком явно, не считается найденной из имени модели.

## Почему prepared snapshot и финальный wire

- Патч LlmRuntime передаёт `providerBudgetCall` из **того же** `adapter.prepareCall`, который владеет stream. У prepared calls сохраняется та же snapshot capability.
- PiAiAdapter создаёт capability и связывает её через closure, не через request JSON. Host resolver принимает только объект из module-private WeakSet. Поддельное `{admit(){...}}` не проходит.
- После admission бюджетированный stream обходит image-recovery ветку, ставит SDK maxRetries=0. Главное — обёртка ниже реального SDK сериализатора допускает **один** fetch за capability: даже случайный внутренний retry второй платный request не отправит.
- Wire проверяется на точный endpoint/model, POST, stream + include_usage, единственный output limit, n=1, только text messages/function tools и ограниченный allowlist полей. Extra body services, media, beta headers, другой output-cap отклоняются до fetch.
- Redirect принудительно `error`. Проверка endpoint происходит до обращения к transport.
- HTTP429/413/обрыв/отсутствие usage оставляют неопределённую экспозицию ledger; повтор требует решения пользователя/нового допуска, не теряет резерв.
- Сырой SSE проверяется **до** SDK-нормализации: требуются терминальный usage-блок с пустыми choices, целые неотрицательные prompt/completion/total, согласованная сумма и cached≤prompt, затем `[DONE]`. Отсутствующий/повреждённый usage не превращается SDK в допустимый нулевой расход: stream завершается ошибкой, резерв остаётся uncertain. Локальный тест проверяет оба случая через настоящий SDK.

## Проверка

`node --test harness-base/tests/usage-provider.test.mjs`: настоящий изолированно скопированный **LlmRuntime + PiAiAdapter + OpenAI SDK**. Перехвачен только fetch, нет платных запросов/чужих ключей. Проверены direct и prepared, actual wire output cap, usage settlement, token rejection до transport, прокси/alias denial, one transport на429/413, missing/malformed raw SSE usage с uncertain hold, подмена cap/model/extra services/media и повторный fetch. Патч idempotent и не меняет живой archive.

`node --test harness-base/tests/budget-project.test.mjs`: **18/18**, включая настоящие persistence/resume/fork/compaction API. Каждый дочерний вызов получает исходный cwd по trusted parentSession, не worktree; неизвестная/сломанная цепочка — отказ.

## Что не утверждается

- Нет live paid-provider smoke-test; поведение SDK/wire проверено локальным транспортным fixture, не реальным списанием денег.
- Не заявляется поддержка выбранного в чате gpt-6.1-sol или произвольного OpenAI-compatible proxy.
- Нет универсального финансового sandbox: arbitrary shell/filesystem с доступом к home может менять код/ledger. Это application authorization при доверенном host.
- Standalone generate_image/video/transcription и прямой вызов adapter мимо LlmRuntime не входят в этот ledger.
- Нет точного счёта провайдера; цены/кеш/налоги/изменения сервера должны сверяться пользователем.

Сборка применяет сначала `apply-usage-budget.py`, затем `apply-usage-provider.py`, и лишь потом runtime descriptor. Живой исходник не патчится. Исторические1.3.3 и ранний ZIP1.3.4 не использовать как финальную поставку. Окончательный контракт, включая raw SSE usage guard, находится в `dist/verified-1.3.4/QCoderI-1.3.4-local-windows-x64.zip`. Native EXE не менялся после полной сборки; owned runtime дополнен в закрытой staged-копии, descriptor/manifest и ZIP пересверены.
