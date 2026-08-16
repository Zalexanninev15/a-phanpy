# Тесты

Гоняются в Node, без браузера:

```sh
node --test tests/merge-timelines.test.js tests/telegram-adapter.test.js
```

Здесь лежит только то, что можно проверить без сети и DOM: порядок слияния
лент и разбор Telegram-сущностей в HTML. Всё, что требует живого соединения
с Telegram, тестами не покрыто — см. раздел «Что не проверено» в
TELEGRAM.md.
