# Иллюстрация и карточки выполнения

3 ноября 2026. Иллюстрация создана встроенным image_gen через навык imagegen и сохранена в `assets/qcoderi-observatory.png`. Сборка копирует её в веб-интерфейс; изображение используется в знаке стартового экрана и карточке идеи. Декоративная карточка боковой панели скрыта. Видеоплеер показывает реальный первый кадр ролика и не использует иллюстрацию как заставку.

Промпт:

> Use case: stylized-concept. Asset type: production illustration for QCoderI desktop app, a wide 3:2 landscape artwork used in small interface cards. A luminous violet crystal observatory floating above a moonlit indigo sea, a graceful silver crescent and delicate orbital light trails, a tiny cinematic film prism hovering above the water, soft lavender and teal reflections. Refined premium 3D editorial illustration, elegant glass and satin metal materials, atmospheric depth, calm and uncluttered. Dark midnight navy background seamlessly fading to #11101c at the edges, concentrated detail near center, beautiful at small sizes. No people, no letters, no typography, no logos, no watermark. Actual artwork only, no UI mockup, no frame.

`studio-activity.js` показывает реальное состояние выполнения и прошедшее время. Для текста и работы агента используется неопределённый индикатор; для видео — процент NiceAI, если он предоставлен. `studio-tasks.js` показывает завершённые пункты штатной проекции todos, текущие пункты и очередь. Процент задач вычисляется из числа завершённых пунктов и их общего количества.

Анимации отключаются при системной настройке уменьшения движения. Видеоплеер имеет ручные элементы управления и `preload=auto`; автоматическое воспроизведение выключено. Готовые MP4 кешируются локально. Пользователь может свернуть результат, открыть оригинал, повторить загрузку и проверить статус без создания нового платного задания. Результат находится в ленте разговора, параметры длительности — над полем ввода.
