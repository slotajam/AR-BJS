# Operations

## Deployment

1. `cp .env.example .env` and set strong values for `RIP_SECRET_KEY`, `POSTGRES_PASSWORD`,
   `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, `RIP_CONTACT_EMAIL` and `RIP_CORS_ORIGINS`.
2. `docker compose up -d --build`. The `migrate` service applies Alembic migrations before `api` and
   `worker` start.
3. Put a TLS-terminating reverse proxy in front of `web` (port 8080).
4. Run `docker compose exec api python -m app.cli verify-connectors` and keep the report.
5. Optional: `RIP_ALLOW_REGISTRATION=false`, then `python -m app.cli create-user EMAIL NAME`.

Upgrades: `git pull && docker compose up -d --build`. Migrations run automatically.
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
