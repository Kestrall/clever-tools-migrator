# Migrate an existing project to Clever Cloud

A project that runs fine with `docker compose up`, on Heroku or on a VPS rarely runs as is on a PaaS: databases are managed add-ons, the filesystem is not persistent, the application must listen on `0.0.0.0:8080`, configuration lives in environment variables...

`clever migrate` analyzes a project **without touching it or calling the API**, lists everything that would prevent it from working on Clever Cloud, and builds a migration plan: instance type, add-ons, environment variables, files and the exact `clever` commands to run.

```bash
clever migrate                 # analyze the current directory
clever migrate ../my-project   # analyze another directory
clever migrate --type node     # evaluate a native runtime instead of the Dockerfile
clever migrate --format json   # machine readable report
clever migrate --strict        # exit code 1 if blockers remain (CI)
clever migrate --write         # create the proposed files (never overwrites)
```

## Apply the plan

`clever migrate apply` turns the plan into files, without touching Clever Cloud:

```bash
clever migrate apply                          # auto: new branch if the git repository is clean, a copy otherwise
clever migrate apply --mode branch            # new branch clever-cloud-migration (--branch to rename it)
clever migrate apply --mode folder -o ../out  # copy of the project (default: <project>-clever)
clever migrate apply --dry-run                # show what would be written
```

| File | Content |
|---|---|
| `clevercloud/cron.json` | Scheduled jobs translated from a `crontab` |
| `.dockerignore` | Created for Docker applications: secrets, git history, local dependencies |
| `.gitignore` | `.env` and `.env.clever` added when needed |
| `.env.clever` | Production variables built from `.env` / `env_file`: compose hostnames removed, `development` switched to `production`, missing variables from `.env.example` listed as `TODO`. **Never committed** |
| `clever-setup.sh` | Creates the application and add-ons, imports `.env.clever`, sets the `CC_*` variables and rebuilds variables such as `DATABASE_URL` from the add-on (`postgresql+psycopg://` scheme kept) |
| `CLEVER-MIGRATION.md` | Steps, generated files, remaining manual changes and what was handled |

Safety rules:

- the original project is never modified in folder mode, and a branch is only created on a clean repository
- commits only contain the generated files (any other local change stays uncommitted)
- existing files are never overwritten, except `.gitignore` which is only appended to
- nothing is pushed and nothing is created on Clever Cloud: review the branch, then run `./clever-setup.sh`

`clever env import` replaces all the variables of the application, so the script imports `.env.clever` before setting the other variables.

## Report

Findings are sorted by severity:

| Severity | Meaning |
|---|---|
| ✘ **blocker** | The application will not build, start or reach its services without this change |
| ! **warning** | It will probably start, but break or lose data in production |
| i **info** | Optimization or information |

A readiness score (100 = deployable as is) summarizes the result, followed by the **migration plan**:

```
Migration plan

  Add-ons
    postgresql-addon shop-api-postgresql (replaces "db")
    redis-addon shop-api-redis (replaces "cache")

  Environment variables
    CC_DOCKER_EXPOSED_HTTP_PORT = 3000  # The image listens on 3000 instead of 8080

  Commands
    $ clever create --type docker shop-api
    $ clever addon create postgresql-addon shop-api-postgresql --link shop-api
    $ clever addon create redis-addon shop-api-redis --link shop-api
    $ clever env set CC_DOCKER_EXPOSED_HTTP_PORT 3000
    $ git add . && git commit -m "Prepare deployment on Clever Cloud"
    $ clever deploy
```

## Runtime selection

1. `--type` if given
2. `docker` when a Dockerfile exists: it is the most faithful way to reproduce what already works. The native runtime that could replace it is reported as an alternative.
3. Otherwise the detected runtime: `php`, `node`, `static`, `python`, `go`, `rust`, `ruby`, `maven`, `gradle`, `sbt`, `elixir`

## What is checked

### Docker

- Dockerfile not at the root or not named `Dockerfile` → `CC_DOCKERFILE`
- `EXPOSE`/`ENV PORT` different from 8080 → `CC_DOCKER_EXPOSED_HTTP_PORT`
- Extra ports → `CC_DOCKER_EXPOSED_TCP_PORT` and `clever tcp-redirs`
- `VOLUME` → not persistent, FS Buckets are not available for Docker: Cellar or a database
- Missing `CMD`/`ENTRYPOINT`, `ARG` without default (env vars are passed as `--build-arg`), private registry (`CC_DOCKER_LOGIN_*`), `HEALTHCHECK` (→ `CC_HEALTH_CHECK_PATH`), missing `.dockerignore`

### Docker Compose

Compose is not supported: every service is translated.

| Service image | Becomes |
|---|---|
| postgres, postgis, timescaledb, pgvector | `postgresql-addon` |
| mysql, mariadb, percona | `mysql-addon` |
| mongo | `mongodb-addon` |
| redis, valkey, keydb | `redis-addon` (or Materia KV) |
| elasticsearch, opensearch | `es-addon` |
| minio, localstack | `cellar-addon` |
| keycloak, matomo, metabase, otoroshi, jenkins, pulsar | matching add-on |
| nginx, traefik, caddy, haproxy, certbot | not needed (load balancer and TLS are provided) |
| adminer, phpmyadmin, pgadmin, mailhog, mailpit | development only |
| rabbitmq, kafka, nats | no managed equivalent, alternatives listed |
| other images / other `build:` services | separate application |

For the application service, it also detects:

- variables pointing to other services (`DATABASE_URL=postgres://…@db:5432`, `REDIS_HOST=cache`) and the add-on variable to use instead (`POSTGRESQL_ADDON_URI`, `REDIS_HOST`…)
- literal variables to copy, secrets and `${VAR}` to define manually, `env_file` to import
- published port, volumes, Docker socket (`CC_MOUNT_DOCKER_SOCKET`), `command:` overrides
- workers built from the same sources (`CC_WORKER_COMMAND` on native runtimes, separate linked app on Docker)
- `docker-entrypoint-initdb.d` scripts that managed databases will not run

### Runtimes

| Runtime | Checks |
|---|---|
| Node.js | `start`/`main` present, dev server in `start`, `build` never run (`CC_POST_BUILD_HOOK`), build tools in devDependencies (`CC_NODE_DEV_DEPENDENCIES`), Node version, Yarn Berry, `next start -p`, SQLite |
| Static | SSG auto-build, Vite/CRA/Angular build (`CC_BUILD_COMMAND`, `CC_WEBROOT`), SPA routing fallback |
| PHP | `CC_WEBROOT=/public`, `CC_PHP_VERSION` from composer.json, Symfony (`APP_ENV`, `APP_SECRET`, Doctrine migrations in `CC_PRE_RUN_HOOK`), Laravel (`APP_KEY`, migrations, `storage/`) |
| Python | `CC_PYTHON_MODULE` for Django/Flask/FastAPI/Starlette, `CC_PYTHON_BACKEND=uvicorn` for ASGI, `CC_PYTHON_MANAGE_TASKS`, `CC_PYTHON_VERSION`, port 9000 with `CC_RUN_COMMAND` |
| Go | `go.mod`, main package outside the root (`CC_GO_PKG`) |
| Rust | several binaries or workspace (`CC_RUST_BIN`) |
| Ruby | `config.ru`, Rails (`SECRET_KEY_BASE`, `CC_RAKEGOALS`) |
| Java | `server.port` different from 8080 |

### Everything else

- No git repository (`clever deploy` pushes commits), already linked (`.clever.json`)
- `.env` files (not read in production, `clever env import`), `.env` not ignored by git, variables expected by `.env.example`
- `Procfile` → `CC_RUN_COMMAND`, `CC_PRE_RUN_HOOK`, `CC_WORKER_COMMAND_n`
- Other platforms: Heroku, Scalingo, Fly.io, Render, Railway, Vercel, Netlify, App Engine, Nixpacks, Elastic Beanstalk, Kubernetes manifests
- Source code: hard-coded ports, servers bound to `localhost`, `postgres://localhost`-like connection strings, SQLite databases, upload folders
- `crontab` → generated `clevercloud/cron.json`

## Limits

The analysis is static and heuristic: it reads files, it does not build or run the project. It may miss things (dynamic configuration, monorepos) or report false positives. Always review the plan before running the commands.
