# Сборка

## Один раз

Распаковать архив поверх чистого `cheeaun/phanpy` (файлы перезаписываются),
затем:

```sh
npm install
npm run build
```

`npm ci` тоже работает — `package-lock.json` в архиве обновлён под две новые
зависимости (`teleproto`, `vite-plugin-node-polyfills`).

Готовый сайт лежит в `dist/`. Это `index.html` плюс папка `assets/`.

## Разработка

```sh
npm run dev      # http://localhost:5173
```

Для правок пользуйтесь этим, а не `build` — пересборка занимает полминуты,
dev-сервер обновляет страницу мгновенно. Вход в Mastodon с localhost
работает: `redirect_uri` берётся из адреса, откуда открыта страница.

## Посмотреть собранное локально

```sh
npm run preview
```

Открывать `dist/index.html` двойным кликом бесполезно — это SPA с ES-модулями
и service worker'ом, по `file://` она не запустится. Нужен http, любой:
`npx serve dist` тоже подойдёт.

## Выложить

`dist/` — обычная статика, кладётся куда угодно: Cloudflare Pages, Netlify,
GitHub Pages, nginx. Сервер должен отдавать `index.html` на неизвестные пути,
иначе прямые ссылки вида `/merged` будут давать 404. На Pages и Netlify это
включено по умолчанию.

## Проверки

```sh
node --test tests/merge-timelines.test.js tests/telegram-adapter.test.js
grep -rl InvokeWithLayer dist/assets/*.js
```

Первое — 21 тест на порядок слияния лент и разбор Telegram-сущностей.
Второе должно что-то находить: если пусто, значит MTProto опять выпал из
сборки, подробности в TELEGRAM.md.

## Если сборка падает

`Cannot find module './iconify-icons/...'` — не отработал `postinstall`.
Лечится `node scripts/generate-icons.js`.

## GitHub Actions

Два файла в `.github/workflows/`:

- **`ci.yml`** — тесты, сборка, проверки, артефакт `dist`. Работает как есть,
  секретов не требует.
- **`deploy.yml`** — выкладка на Cloudflare Pages. Опциональный, нужны секреты
  `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID`. Не нужен — удалите файл.

Разнесены намеренно: будь деплой job'ом внутри `ci.yml`, отсутствующий секрет
красил бы каждый обычный пуш в красное.

### Что проверяет ci.yml

Кроме тестов и сборки — три вещи, которые сборка не ловит, потому что при них
она остаётся зелёной:

1. **MTProto есть в бандле.** Если `loadLib()` перепишут обратно на spread
   namespace-объекта, rolldown молча выкинет teleproto, и ошибка вылезет
   только в рантайме.
2. **MTProto нет в главном чанке.** Обратная поломка: если библиотека
   загрузится статически, все пользователи будут качать лишние ~500 КБ gzip.
   Плюс потолок в 700 КБ на главный чанк (сейчас 413 КБ).
3. **Строки общей ленты на месте.**

Размеры чанков пишутся в summary прогона.

Проверки прогнаны в обе стороны: на настоящей сборке проходят, на нарочно
сломанной падают. Первая версия проверки №1 проходила и на сломанной — она
матчила sourcemap'ы, отсюда `--include="*.js"`.

### Workflow апстрима

В форке стоит удалить — они завязаны на инфраструктуру автора и будут
падать:

```
.github/workflows/{bundle-size,custom-build,i18n-automerge,
  i18n-update-readme,main2prod,prodtag,rollbar-deploy,update-catalogs}.yml
```

`autofix.yml` и `playwright.yml` можно оставить.

### Про playwright

`playwright.config.js` теперь явно задаёт `testMatch: '**/*.spec.js'`.
Мои файлы в `tests/` называются `*.test.js` и гоняются через `node --test`;
в некоторых версиях Playwright дефолтный паттерн захватывает и `.test.js`,
и тогда он попытался бы запустить их как браузерные тесты.
