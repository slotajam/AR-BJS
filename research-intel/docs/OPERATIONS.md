# Operations

## Deployment

### Public website on your own domain (recommended)

1. **Server:** Ubuntu 22.04/24.04 with at least 2 vCPU, 4 GB RAM and 40 GB disk (more for many PDFs).
   Install Docker: `curl -fsSL https://get.docker.com | sh`.
2. **DNS:** at your domain registrar, create an **A record** (and AAAA for IPv6, if the server has one)
   for e.g. `research.example.org` pointing to the server's public IP.
3. **Firewall:** open ports 22, 80 and 443 in your cloud provider's firewall and on the host
   (`ufw allow 22,80,443/tcp && ufw enable`). Port 80 is needed for Let's Encrypt validation and
   the HTTP→HTTPS redirect.
4. **Start:**
   ```bash
   git clone https://github.com/slotajam/AR-BJS.git && cd AR-BJS/research-intel
   ./rip.sh start --domain research.example.org --email you@example.org
   ./rip.sh admin      # create the first account
   ./rip.sh verify     # live OpenAlex / Crossref check
   ```
   `--domain` writes `RIP_DOMAIN`, `RIP_ACME_EMAIL`, `RIP_CORS_ORIGINS=["https://…"]`,
   `RIP_ALLOW_REGISTRATION=false` and `COMPOSE_FILE=docker-compose.yml:docker-compose.domain.yml`
   to `.env`, so every later `./rip.sh` or `docker compose` command includes the Caddy front end.
   Add `--open-registration` to let anyone create an account.
5. **Backups:** schedule `./rip.sh backup` daily (cron) and copy `backups/` off the server.

How it fits together:

```
internet ─▶ caddy :80/:443 (TLS, Let's Encrypt, HTTP→HTTPS) ─▶ web (nginx: SPA + /api proxy) ─▶ api ─▶ db / redis / minio
                                                    127.0.0.1:8080 ─┘ (local access / your own proxy)
```

- Certificates live in the `caddy_data` volume and renew automatically. Keep that volume.
- Caddy streams live job progress unbuffered (`flush_interval -1`) and sends HSTS.
- nginx trusts `X-Forwarded-For` only from the Docker network and 127.0.0.1, so the per-IP login
  throttle sees real client addresses and clients cannot spoof theirs.
- To change the domain, run `./rip.sh start --domain new.example.org` again.
- To go back to local-only, delete the `COMPOSE_FILE` and `RIP_DOMAIN` lines from `.env`, then
  `docker compose down caddy` (or `./rip.sh stop`) and `./rip.sh start`.

Troubleshooting: `./rip.sh logs caddy` shows certificate progress. The usual causes of failure are
DNS not yet pointing at the server, or port 80 blocked by a cloud firewall. Let's Encrypt rate-limits
repeated failures, so fix DNS and ports before retrying many times.

### Behind an existing reverse proxy / on a private network

`./rip.sh start` without `--domain` serves the app on `127.0.0.1:8080` only. Point your own proxy
(nginx, Apache, IIS, a load balancer) at it and terminate TLS there; set `RIP_CORS_ORIGINS` to the
public origin. On a trusted private network you can instead expose it directly with
`RIP_BIND=0.0.0.0` in `.env` (plain HTTP, so not over the internet).

### Manual setup

1. `cp .env.example .env` and set strong values for `RIP_SECRET_KEY`, `POSTGRES_PASSWORD`,
   `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, `RIP_CONTACT_EMAIL` and `RIP_CORS_ORIGINS`.
2. `docker compose up -d --build`. The `migrate` service applies Alembic migrations before `api` and
   `worker` start. All long-running services restart automatically after a reboot.
3. Run `docker compose exec api python -m app.cli verify-connectors` and keep the report.
4. Optional: `RIP_ALLOW_REGISTRATION=false`, then `python -m app.cli create-user EMAIL NAME`.

Upgrades: `./rip.sh update` (or `git pull && docker compose up -d --build`). Migrations run automatically.
To check that the schema matches the models: `docker compose run --rm migrate alembic check`.

## Job durability and recovery

- All job state (status, stage, progress, checkpoint) lives in PostgreSQL. Celery only carries the job ID.
- `task_acks_late` and `task_reject_on_worker_lost` mean a task is re-delivered if a worker dies.
  Redis runs with AOF persistence.
- Search jobs save a checkpoint (cursor and counts) after every page. Collection jobs save the
  done/failed paper IDs after every paper.
- `POST /jobs/{id}/retry` resumes failed, partial or cancelled jobs from the checkpoint. Duplicate
  deliveries of finished jobs do nothing.
- Orphaned jobs (still `running` with no update for 15 minutes) can be re-queued with
  `python -m app.cli resume-stale`. Schedule it every few minutes with cron.

## Backup

| Data | Command |
|---|---|
| PostgreSQL | `docker compose exec db pg_dump -U rip -Fc rip > rip-$(date +%F).dump` |
| Object storage | `mc mirror local/rip-private ./backup/rip-private` (or S3 bucket versioning / replication) |
| Config | Keep `.env` in your secret manager, not with the backups |

Back up the database and the bucket at the same time. File rows refer to objects by `storage_key`.
Daily backups with 30-day retention are a reasonable default.

## Restore

```bash
docker compose up -d db minio
docker compose exec -T db pg_restore -U rip -d rip --clean --if-exists < rip-YYYY-MM-DD.dump
mc mirror ./backup/rip-private local/rip-private
docker compose up -d
docker compose run --rm migrate alembic upgrade head
```

Integrity check after a restore: every `files.sha256` should equal the SHA-256 of its object.

## Retention and deletion

| Data | Retention | Deletion |
|---|---|---|
| Projects (papers, observations, files, chunks, embeddings, evidence, rankings, exports) | Until the owner deletes the project | `DELETE /api/v1/projects/{id}` (owner only) removes stored PDFs and export ZIPs, then all rows (cascade) |
| Export ZIPs | Kept with the project; suggested lifecycle rule: expire `projects/*/exports/` after 30 days | Bucket lifecycle policy |
| Audit logs | Kept after project deletion (no FK); suggested retention of 1 year | Periodic `DELETE FROM audit_logs WHERE created_at < now() - interval '1 year'` |
| User accounts | Until removed by an operator | Deactivate with `UPDATE users SET is_active=false`. Remove memberships before hard deletion |
| Backups | Per your backup policy (e.g. 30 days) | Deleted data persists in backups until they expire. Document this for data subjects |

Uploaded PDFs that were obtained under licensed access should be deleted when the licence ends
(delete the project, or remove the file and set the paper back to discovery-only via SQL).
A per-file deletion endpoint is planned for Phase 2.

## Monitoring

- Health: `GET /api/v1/health` (checks the database).
- Connector state: `GET /api/v1/connectors/status`.
- Failed jobs: `SELECT kind, status, error FROM jobs WHERE status IN ('failed','partial') ORDER BY created_at DESC`.
