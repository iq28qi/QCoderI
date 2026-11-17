# Moonlight Studio

Дизайн QCoderI создан по предоставленному пользователем референсу: ночная аниме-иллюстрация, индиго, лиловое свечение, прозрачные панели и орбитальная буква Q. Текст, кнопки, списки диалогов и настройки отрисованы приложением, поэтому остаются интерактивными.

## Редактирование

- `assets/moonlight.css` — основной слой оформления поверх `assets/aurora.css`.
- `source/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js` — верхняя навигация.
- `source/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` — стартовый экран, карточки задач и заполнение черновика.
- `source/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js` — боковая панель.
- `source/dsh/node_modules/@deepseek-ai/dsh-client-ui-brand-official/lib/client.js` — события навигации к существующим разделам.
- `source/lib/main.js` — нативные кнопки окна Windows и область заголовка.

`build.py` копирует CSS и фоновую иллюстрацию из `assets` в веб-приложение, обновляет контрольные суммы ресурсов и упаковывает приложение. Отдельный `repack.py` позволяет быстро упаковать выбранные файлы относительно `source`.

Не добавляйте `backdrop-filter`, `filter` или `transform` на предков модального окна настроек: это меняет систему координат `position: fixed` и может обрезать диалог боковой панелью.

## Поведение

Разделы «Файлы» и «Терминал» открывают настоящую панель выбранной рабочей области. «Код» открывает её файловый обозреватель с просмотром кода. «Агенты» ведут к профилям агентов, «Инструменты» — к плагинам, «Ресурсы» — к моделям. Карточки задач дополняют черновик, сохраняя уже введённый текст; запрос автоматически не отправляется.

Длинные переписки показываются на более плотном тёмном фоне. Светлая тема сохраняет читаемые панели. Для компактного окна уменьшаются заголовки и карточки; системная настройка уменьшения движения отключает декоративную анимацию.

## Иллюстрация

Режим: встроенный инструмент `image_gen`, создание по визуальному референсу. Исходная картинка пользователя использована только для стиля и композиции. Финальный ресурс проекта: `G:\QCoderI\harness-base\assets\qcoderi-moonlit-elf.png`. Копия для упаковки: `source/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/qcoderi-moonlit-elf.png`.

Промпт:

```text
Production background illustration for the QCoderI desktop app, inspired by the attached reference. Generate ONLY the illustration: NO text, logos, interface, controls, borders or panels. Wide landscape 16:10. High-end anime painting, midnight indigo and violet moonlight, luminous lilac petals. A clearly adult elf woman age 25+, silvery white shoulder length hair, violet eyes and pointed ears, elegant dark navy off-shoulder fantasy cloak, waist-up portrait, looking toward viewer; positioned in the far RIGHT THIRD, face around x83%, y24%. Behind her is an arched moonlit window with a large violet moon. Dark wisteria leaves frame the left and bottom, subtle reflections across dark floor. LEFT TWO THIRDS and CENTER are almost black, open and low-detail for readable real interface overlays. Detailed luminous hair strands, delicate face shading, restrained violet rim glow, rich details concentrated on right. Match the reference's atmosphere and character aesthetic, no extra characters, no watermarks.
```
