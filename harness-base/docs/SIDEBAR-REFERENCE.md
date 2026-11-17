# Боковая панель по референсу

Референс: присланная пользователем панель 180 × 588 px. Основные размеры перенесены в рабочую панель шириной 256 px при высоте окна 840 px: новый диалог — y=78, навигация — y=143, разделитель — y=367, система — y=613, профиль — y=720, нижние действия — y=793. Сохранено сворачивание, изменение ширины, светлая тема и компактная компоновка. Старое значение ширины по умолчанию 280 мигрирует в 256; новые пределы изменения ширины — 240–360 px.

`assets/sidebar-reference.css` задаёт оформление. `assets/studio-sidebar.js` содержит живые элементы меню. Значок колокольчика открывает сообщения приложения, облако — подключения моделей, питание — штатное завершение приложения через IPC, ограниченный собственным renderer. Привилегированные методы отсутствуют на странице запуска. Меню выбранного нового диалога доступно через штатную кнопку с многоточием. История и показания CPU/RAM настоящие; GPU без доступного измерения отображается как отсутствие данных.

Фон: `G:/QCoderI/harness-base/assets/qcoderi-sidebar-moon-v1.png`. Создан встроенным `image_gen` из присланного изображения, затем скопирован в проект. Исходный результат: `C:/Users/user/.codex/generated_images/01a1a624-4e5c-7d52-b9e6-09fdf67c1ef3/exec-e9a17b1a-bd8c-4b7e-ac8a-ce1f5e7cb0cd.png`. Прозрачность не запрашивалась; кнопки, текст и показатели отрисовываются приложением поверх фоновой иллюстрации.

Использованный промпт:

```text
Edit the supplied narrow sidebar screenshot into ONLY its decorative background, removing ALL foreground interface: no text, letters, logo, button, icon, border, glass panel, charts, gauges or avatars. Preserve the original almost-black midnight navy and dark violet colors and original background composition as closely as possible. Tall vertical wallpaper about 1:3.25 aspect ratio for a 256px wide desktop sidebar. Upper 25 percent almost black and empty. At right edge around 38 percent down, small lavender moon partly cropped by right edge, thin dark wisteria branches and leaves silhouetted across it; subtle navy-blue glow around moon, dark violet petals along the lower-right edge around 68 percent down. Lower quarter almost black again for UI overlays. Keep 80 percent of the background very dark, especially left side: this is an understated sidebar wallpaper behind live UI. Do not add a character or landscape or objects. Faithfully reconstruct the reference's BACKGROUND ONLY.
```

Проверка — UI smoke в отдельном `DSH_HOME`, геометрия панели в `tests/.runtime/sidebar-reference-geometry.json`, превью реального интерфейса — `tests/sidebar-reference-preview.png`. Пользовательское хранилище в проверке не используется.
