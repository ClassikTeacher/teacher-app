# Деплой backend — runbook

Один Ubuntu-сервер (22.04/24.04), всё в Docker Compose: Caddy (TLS, Let's Encrypt) → `api`; `worker`; PostgreSQL 16, Redis 7,
RustFS (S3). Образ собирает CI и публикует в GHCR; деплой — ручной workflow в GitHub Actions с подтверждением.
Стейджа нет: `main` = прод.

```text
PR → CI (lint, typecheck, format, unit, integration, build, smoke-тест образа)   ← обязательная проверка перед merge
merge в main → CI → образ ghcr.io/classikteacher/teacher-app/backend:{sha-xxxxxxx, main, latest}
Actions → Deploy → Run workflow (тег) → подтверждение reviewer'ом → ssh на сервер → deploy.sh <тег>
deploy.sh: pull → дамп БД → миграции → перезапуск api/worker → ожидание /health → (откат при неудаче)
```

Файлы: `backend/deploy/` (compose, Caddyfile, `.env.prod.example`, `deploy.sh`, `server-setup.sh`, `backup.sh`),
`.github/workflows/ci.yml`, `.github/workflows/deploy.yml`.

## 1. Настройка GitHub (один раз)

Это делается в интерфейсе GitHub, из репозитория не настраивается.

1. **Branch protection для `main`** (Settings → Branches → Add rule, или Rulesets):
   «Require a pull request before merging», «Require status checks to pass» — отметить
   `backend · lint, typecheck, test, build` и `images · build, smoke test, publish`, «Require branches to be up to date».
2. **Environment `production`** (Settings → Environments → New environment):
   - **Required reviewers** — кто подтверждает деплой (это и есть «вручную с подтверждением»; можно указать себя).
   - Secrets:

     | Secret               | Что это                                                                                               |
     | -------------------- | ----------------------------------------------------------------------------------------------------- |
     | `DEPLOY_HOST`        | IP или хост сервера                                                                                   |
     | `DEPLOY_USER`        | `deploy` (пользователь из `server-setup.sh`)                                                          |
     | `DEPLOY_SSH_KEY`     | приватный ключ (`ssh-keygen -t ed25519 -C deploy -f deploy_key`, без пароля), целиком с заголовками   |
     | `DEPLOY_KNOWN_HOSTS` | вывод `ssh-keyscan -H <host>` (необязательно; без него ключ хоста принимается при первом подключении) |

   - Variables: `DOMAIN` (например `tutor.example.com` — после деплоя workflow проверяет `https://DOMAIN/health`),
     при необходимости `DEPLOY_PORT` (по умолчанию 22) и `APP_DIR` (по умолчанию `/opt/tutor-platform`).
3. **Пакет GHCR**: после первой публикации образа (первый push в `main`) пакет `backend` появится в
   Packages организации; он привязан к репозиторию, и `GITHUB_TOKEN` workflow'а Deploy может его читать.
   Для приватного репозитория ничего больше не нужно; если пакет сделать публичным — сервер сможет делать `pull` без логина.
4. Settings → Actions → General → Workflow permissions: «Read and write permissions» не требуется —
   права выданы на уровне job (`packages: write` только в job `images`).

## 2. Подготовка сервера (один раз)

Свежий Ubuntu, от root:

```bash
curl -fsSL https://raw.githubusercontent.com/ClassikTeacher/teacher-app/main/backend/deploy/server-setup.sh \
  | sudo bash -s -- "ssh-ed25519 AAAA...публичный ключ из deploy_key.pub..."
```

Скрипт идемпотентен: ставит Docker + compose plugin, создаёт пользователя `deploy` (группа docker) с этим ключом,
каталог `/opt/tutor-platform` (с `backups/`), ufw (22, 80, 443), unattended-upgrades, лимиты логов docker.

Затем под `deploy`:

```bash
sudo -iu deploy
curl -fsSLo /opt/tutor-platform/.env https://raw.githubusercontent.com/ClassikTeacher/teacher-app/main/backend/deploy/.env.prod.example
chmod 600 /opt/tutor-platform/.env
nano /opt/tutor-platform/.env
```

В `.env` заполнить: `DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD`, `S3_SECRET_KEY`, `PUBLIC_BASE_URL=https://<DOMAIN>`,
`TELEGRAM_WEBHOOK_SECRET`, четыре `BOT_*_TOKEN` и `BOT_*_USERNAME`, `BOOTSTRAP_SUPERADMIN_TELEGRAM_ID`,
`SYSTEM_KEY_HASH`, `JWT_SECRET` (комментарии в файле подсказывают, чем генерировать). Приложение в production
отказывается стартовать с плейсхолдерами (`change-me`, `minioadmin`, …) и с `PUBLIC_BASE_URL` не на https.
`IMAGE_TAG` трогать не нужно — его пишет `deploy.sh`.

DNS: A/AAAA-запись `DOMAIN` → IP сервера (до первого деплоя, иначе Caddy не получит сертификат; Telegram принимает
вебхуки только по HTTPS на 443).

## 3. Первый деплой

1. Влить изменения в `main`, дождаться зелёного CI — в Summary job `images` будет тег `sha-xxxxxxx`.
2. Actions → **Deploy** → Run workflow. Поле `image_tag` можно оставить пустым (возьмётся `sha-` коммита выбранной
   ветки) или указать `sha-xxxxxxx`. Reviewer подтверждает запуск в окружении `production`.
3. Workflow проверяет наличие образа в GHCR, копирует `backend/deploy/` на сервер (`.env` не трогает),
   запускает `deploy.sh`, затем ждёт `https://DOMAIN/health`.
4. Создать супер-админа (один раз):

   ```bash
   cd /opt/tutor-platform && docker compose -f docker-compose.prod.yml run --rm seed-superadmin
   ```

   Скрипт печатает одноразовую ссылку в AuthBot для `BOOTSTRAP_SUPERADMIN_TELEGRAM_ID`.

Вебхуки ботов регистрируются при старте `api` (`TELEGRAM_MODE=webhook`, адрес `PUBLIC_BASE_URL/api/v1/tg/<bot>/webhook`).

## 4. Обновление

То же самое: merge в `main` → Deploy с новым тегом. `deploy.sh` делает по порядку:

1. `docker login ghcr.io` токеном workflow'а (через stdin, после деплоя — logout), `pull` образа;
2. поднимает `postgres`, `redis`, `s3` (если ещё не подняты) и ждёт их healthcheck;
3. дамп БД в `backups/pre-deploy-<время>-<текущий тег>.sql.gz` (хранятся последние 10);
4. миграции — `docker compose run --rm migrate` (тот же образ, `node dist/scripts/migrate.js`: advisory-lock,
   контроль checksum, каждая миграция в своей транзакции);
5. `docker compose up -d --wait api worker` — ждёт healthcheck `api` до 180 с;
6. при успехе записывает `.deploy/current` и `.deploy/previous`, обновляет `IMAGE_TAG` в `.env`, поднимает Caddy;
   при неудаче печатает логи, возвращает предыдущий тег и завершается с ошибкой (workflow красный).

На время перезапуска `api` (несколько секунд) запросы получают 502 от Caddy; очередь Telegram доставит апдейты повторно.
Деплои сериализованы (`concurrency: deploy-production`): второй запуск ждёт первого.

Миграции — только вперёд и обратно совместимые (DoD в `WORK-PLAN.md`): откат образа не откатывает схему.

## 5. Откат

- Из GitHub: Deploy → Run workflow с предыдущим тегом `sha-…` (список тегов — в Packages или в истории Deploy).
- На сервере: `/opt/tutor-platform/deploy.sh --rollback` (предыдущий тег из `.deploy/previous`) либо
  `deploy.sh sha-xxxxxxx`. Для `pull` старого образа вручную нужен логин в GHCR: `echo <PAT read:packages> | docker login
ghcr.io -u <login> --password-stdin`; образ, который уже деплоился, обычно ещё есть локально.
- Деплоить всегда `sha-`тегом, а не `main`: `main` «едет» с каждым merge, и откат на него бессмысленен.
- Восстановление БД из дампа (крайний случай, с остановкой api/worker):

  ```bash
  cd /opt/tutor-platform
  docker compose -f docker-compose.prod.yml stop api worker
  gunzip -c backups/pre-deploy-....sql.gz | docker compose -f docker-compose.prod.yml exec -T postgres psql -U tutor -d tutor
  docker compose -f docker-compose.prod.yml up -d api worker
  ```

## 6. Эксплуатация

```bash
cd /opt/tutor-platform
./deploy.sh --status                                    # текущий/предыдущий тег, состояние контейнеров
docker compose -f docker-compose.prod.yml logs -f --tail=200 api worker
docker compose -f docker-compose.prod.yml exec postgres psql -U tutor -d tutor
docker compose -f docker-compose.prod.yml restart api   # после правки .env
```

Бэкапы: `backup.sh` — ночной `pg_dump` (хранить 14 дней), в crontab пользователя `deploy`:

```text
15 3 * * * /opt/tutor-platform/backup.sh >> /opt/tutor-platform/backups/backup.log 2>&1
```

Дампы лежат на том же сервере — для пилота достаточно, но копировать их наружу (и WAL-архив, M7-03) ещё предстоит.
Файлы S3 (`s3data`), данные Redis (`redisdata`) и сертификаты Caddy (`caddy_data`) — docker-volumes; при переезде
сервера переносить их вместе с `pgdata`.

Ограничения пилота (M7): один сервер без резервирования, нет внешнего мониторинга — только healthcheck контейнеров и
`restart: unless-stopped`; `SWAGGER_ENABLED=false`; антивирус (`CLAMAV_HOST`) не настроен.
