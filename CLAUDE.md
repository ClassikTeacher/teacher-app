# CLAUDE.md — Tutor Platform

Платформа для репетиторов: REST API (NestJS на Fastify), четыре Telegram-бота (grammY) и фоновые воркеры (BullMQ) из одной кодовой базы. Весь код — в `backend/`. Язык документации, коммитов и интерфейса — русский.

## Документы — читать в этом порядке

| Файл | Что там |
|---|---|
| `PRODUCT-SPEC.md` | Спецификация v0.2: правила с кодами (`CAL-01`, `CNL-07`, `HW-05`…), use-cases (`UC-14`), модель данных (раздел 8), решения `Р-NN` (раздел 12). Источник истины по поведению. |
| `WORK-PLAN.md` | План по вехам M1–M7 (MVP) и эпики этапов 2–3. Definition of Done — раздел 1. |
| `backend/docs/PROGRESS.md` | Статус задач и журнал ревью по каждой. **Обновлять при каждой закрытой задаче.** |
| `backend/docs/DECISIONS.md` | Технические решения `T-NN`. Новое архитектурное решение — новая строка здесь. |
| `backend/docs/DEPLOY.md` | Runbook деплоя: GitHub (branch protection, environment `production`), сервер, обновление, откат, бэкапы. |
| `backend/docs/M*-SUMMARY.md`, `M*-REVIEW.md` | Итоги вех и ревью заказчика; в конце SUMMARY — «контракты для следующих вех» (что уже заложено под M6/этап 2). |

Правило спеки: любое новое требование — через журнал решений (раздел 12), не через чат.

## Текущее состояние (2026-11)

M1–M6 закрыты (M6: журналы, шкалы, статистика, отчёты, ICS, «Успеваемость» в ботах — см. `backend/docs/M6-SUMMARY.md`). Есть CI/CD (GHCR + ручной деплой, `backend/docs/DEPLOY.md`). Из этапа 2 сделан **E2-05 Google Calendar** (фича `calendar.google`, модуль `integrations/google`, мягкая занятость `external_busy` в schedule, T-39). Не начата **M7 «Стабилизация»** (нагрузка, наблюдаемость, бэкапы, безопасность, юридические тексты, пилот). Боты к реальному Telegram ещё не подключались (нет токенов).

Локальный прогон интеграционных тестов без Docker: `TEST_SERVICES=local TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/postgres TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm test:integration` (нужен локальный PostgreSQL 16 с правом CREATE DATABASE и Redis; S3 подменяется встроенным фейком `test/local-services.ts`).

## Команды (из `backend/`)

```bash
pnpm install
docker compose up -d postgres redis s3
pnpm migrate && pnpm seed:superadmin
pnpm dev:api        # http://localhost:3000, Swagger /api/docs
pnpm dev:worker

pnpm lint && pnpm typecheck && pnpm format:check
pnpm test:unit            # без контейнеров
pnpm test:integration     # Testcontainers: PostgreSQL, Redis, S3 — нужен Docker
pnpm test -- <путь>       # один файл
pnpm build
```

CI (`.github/workflows/ci.yml`) гоняет всё перечисленное плюс сборку Docker-образа и smoke-тест `/health`; после merge в `main` публикует образ в GHCR. Деплой — ручной workflow `deploy.yml` (окружение `production` с подтверждением) → `backend/deploy/deploy.sh` на сервере; runbook — `backend/docs/DEPLOY.md`. Prettier проверяет весь `backend/` — после правок запускать `pnpm format`.

## Структура

```text
backend/
  apps/api/src/<area>/*.controller.ts   # REST + вебхуки, тонкие адаптеры; zod-схемы рядом (*.schemas.ts)
  apps/worker/src/                      # WorkerRunner: outbox-публикатор, планировщики, джобы
  libs/shared/src/                      # config (env.schema), db (drizzle, TransactionManager, migrator), redis, s3, logging, errors, ids, time
  libs/modules/<module>/                # identity, access, audit, outbox, people, schedule, notifications, files, content, homework, gradebook, integrations
  libs/telegram/src/
    core/                               # bot-factory, flow (диалоги), sections, callback, ui (escapeHtml), i18n
    auth-bot/ staff-bot/ student-bot/ parent-bot/
    i18n/ru.ftl                         # ВСЕ тексты ботов (Fluent)
  migrations/NNNN_name.sql              # ручные SQL-миграции, применяются по порядку
  test/                                 # harness: db.ts, app.ts, bot.ts, telegram.ts (фейковый Bot API), factories.ts, outbox.ts
```

Алиасы: `@shared/*`, `@modules/*`, `@telegram/*`, `@test/*`. Импорты с расширением `.js` (ESM, NodeNext).

Внутри модуля: `schema.ts` (drizzle), `*.repository.ts`, `*.use-case.ts`, `*.query.ts` (чтение), `*.rules.ts` (чистые функции, unit-тесты), `*.handler.ts` (подписчики событий), `*.job.ts` (воркер), `<module>.module.ts`, `index.ts`.

## Архитектурные инварианты

- **Права проверяет use-case**, а не меню: роль + контекст + статус связи (спека 8.0). Входная точка — `Actor` (`@modules/access/actor.ts`), `assertActive(actor)`. Аккаунт может иметь несколько ролей: роль действия передаётся явно (`as`, T-19).
- **Одна транзакция на use-case** через `TransactionManager.run()` (AsyncLocalStorage, T-10); репозитории берут `txm.db`. В ту же транзакцию пишутся `audit_log` (`AuditService.record`) и `outbox_event` (`OutboxService.publish`). Вложенные — `runSavepoint`.
- **Модули не ходят в чужие таблицы**: только публичные сервисы и доменные события (`libs/modules/outbox/domain-event.ts`, обработчики `*.handler.ts`). Пример: `link.ended` → people закрывает связь, schedule отменяет занятия, homework снимает цели.
- **Ошибки — `AppError` с кодом из `ERROR_CODES`** (`@shared/errors/app-error.ts`); боты мапят код в `error-<code>` из `ru.ftl`, REST — в HTTP-статус. Новый код = новая строка в `.ftl` (есть тест полноты локали).
- **Уведомления**: тип регистрируется в `notifications/types.ts` (`NOTIFICATION_TYPES`, при необходимости `CC_CONFIGURABLE_TYPES`), текст — в обработчике `notifications/handlers/*`, доставка — через таблицу `notification` с `dedupe_key`. Один пакетный текст на получателя вместо N сообщений (NTF-07).
- **Внешние API — порт + фейк в тестах**: Telegram (`test/telegram.ts`), Google (`GOOGLE_API` → `GoogleApiHttp` на `fetch`, в тестах `test/google.ts` через `createTestContext(..., { overrides, env })`). Секреты в БД — только через `SecretBox` (`@shared/crypto`).
- **Гонки решает БД**: `EXCLUDE` для занятости, частичные уникальные индексы, `FOR UPDATE`, advisory-lock на учителя. Порядок блокировок: профиль учителя → связь → заявки → занятие (T-21). Нарушение порядка — deadlock, ревью это ловит.
- **Время**: `timestamptz` в UTC, IANA-пояс у аккаунта, Luxon. Окна и серии — локальное время учителя. DST-тесты обязательны для всего, что считает даты.
- **Пользовательские тексты хранятся как есть**, экранируются при выводе `escapeHtml` (T-11). Системные причины — кодами, текст рендерится по локали (T-24).
- **ID — UUID v7** (`newId()`); физического удаления нет (статусы, `archived_at`, `revoked_at`), кроме файлов в S3 по явной команде.

## Боты

- Все тексты — ключи в `ru.ftl`; литералов в обработчиках нет. Ключи вариантов Fluent — без точек; пустой ключ `[]` недопустим — необязательные фрагменты собирает продюсер (`commentLine`, `kindLine`), а не селектор. Есть unit-тест, который рендерит каждый `ntf-*` шаблон с набором переменных (`notifications/types.test.ts`): новая переменная шаблона добавляется и туда.
- Экран = `SectionModule` (`core/sections.ts`); для StaffBot реестр `staff-bot/sections.ts` задаёт роли и фичи, авторизация кнопок `s:<section>:<action>` центральная.
- Диалог = класс `Flow<D>` (`core/flow.ts`): шаги `enter/onText/onCallback/onMedia`, состояние в сессии (Redis), `complete()` может вернуть `{ goto }`. Терминальные ошибки (`CONFLICT`, `NOT_FOUND`) сбрасывают диалог; лимиты и фичи проверять до старта диалога.
- `callback_data` ≤ 64 байт: короткие ключи, для строк списков — `short-ref` (индекс + 4 hex хвоста UUID, T-16). Id из callback валидировать как UUID. Кнопка должна нести цель действия, а не брать её из сессии.
- Уведомление может нести `buttons`, бот обрабатывает их `data` как обычный callback (T-14).
- Апдейты обрабатывать через `CreatedBot.handle()` (граница ошибок, T-13). Один экземпляр `api` (T-08).

## Тесты

- Unit (`*.test.ts`) — чистые правила, без контейнеров. Интеграционные (`*.integration.test.ts`) и e2e ботов (`*.e2e.test.ts`) — Testcontainers; каждому файлу — своя БД из миграций.
- Harness: `createTestDatabase` → `createTestContext(tdb, [Modules])` (с `FixedClock`), `createBotHarness(definition, actors)` с `FakeTelegram` (`text`, `press`, `callback`), `drainOutbox(ctx, tdb)` для доставки событий без Redis, фабрики в `test/factories.ts` и `test/people.ts`.
- Порядок по плану (TDD): тест правила → use-case → обработчик бота → e2e. Обязательные тесты на гонки (два параллельных вызова), чужие id, завершённую связь, заблокированный аккаунт, повторную доставку события.
- BullMQ 6: в `jobId` нельзя `:`.

## Как закрывать задачу

1. Найти задачу в `WORK-PLAN.md`, правила и UC — в спеке, контракты — в последнем `M*-SUMMARY.md`.
2. Миграция `NNNN_name.sql` (обратно совместимая, с комментарием-ссылкой на раздел спеки) + drizzle-схема в `schema.ts` модуля.
3. Use-case с проверкой прав, аудитом (`AUD-01`) и событиями; REST-контроллер с zod и Swagger-декораторами, если задача трогает API.
4. Тексты в `ru.ftl`, экран или диалог в боте, e2e.
5. `pnpm lint && pnpm typecheck && pnpm format && pnpm test`.
6. Записать в `PROGRESS.md` строку задачи и итоги ревью; новое решение — в `DECISIONS.md`; в конце вехи — `M*-SUMMARY.md` с контрактами для следующей.

Коммиты — по одной задаче, сообщение по-русски с кодом задачи (`M6-01: журналы и шкалы`).
