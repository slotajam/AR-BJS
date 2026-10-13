# Research Paper Intelligence Platform: Phase 1 MVP

A traceable, rights-aware web app for scholarly discovery. You can search OpenAlex and Crossref,
collect permitted PDFs or upload your own, read page-linked evidence, rank papers with a transparent
formula, look at the results in a linked 2D/3D view, and export reproducible CSV/JSON.

Every record, metadata field, PDF, passage, score, plot point and exported row can be traced back to
its source, the retrieval context, the access basis and the processing version.

> **Status:** see [`docs/STATUS.md`](docs/STATUS.md) for the verified status of each item.
> In short, the whole Phase 1 workflow is implemented and tested. Live OpenAlex/Crossref calls have
> **not** been verified, because the network where this was built blocks those hosts. Run
> `python -m app.cli verify-connectors` from a network that can reach them.

## Layout

```
research-intel/
  backend/      FastAPI · SQLAlchemy · Alembic · Celery · PyMuPDF   (tests: pytest against PostgreSQL)
  frontend/     React · TypeScript · Material UI · Plotly.js           (tests: vitest; build: vite)
  docs/         status report, policies, connector matrix, data dictionary, ranking, ops, openapi.json
  docker-compose.yml, .env.example
```

## Quick start (one command)

Requires Docker with Compose v2.

```bash
cd research-intel
./rip.sh start     # first run writes .env with random secrets, builds, starts and waits until healthy
# → http://localhost:8080  (create an account in the browser, or: ./rip.sh admin)
./rip.sh verify    # live OpenAlex / Crossref check from your network (do this once)
```

### Publish it as a website (HTTPS on your own domain)

On a Linux server with Docker, after pointing a DNS A record for your domain at the server:

```bash
./rip.sh start --domain research.example.org --email you@example.org
./rip.sh admin     # self-registration is switched off for public sites; create accounts here
```

This adds a [Caddy](https://caddyserver.com) front end (`docker-compose.domain.yml`) that gets and
renews a Let's Encrypt certificate and redirects HTTP to HTTPS. The app itself listens only on
`127.0.0.1:8080`. Ports 80 and 443 must be open. Full guide: [docs/OPERATIONS.md](docs/OPERATIONS.md#deployment).

Other commands: `./rip.sh status | logs | stop | backup | update`.
A user guide in Thai is at [docs/USER_GUIDE_TH.md](docs/USER_GUIDE_TH.md).
Optional labelled sample project (offline fixture data):
`docker compose exec api python -m app.cli seed-demo you@example.org`.

Manual setup: `cp .env.example .env`, fill in the secrets, then `docker compose up -d --build`.

Services: `db` (PostgreSQL 16 + pgvector), `redis` (AOF-durable broker), `minio` (private bucket),
`migrate` (runs `alembic upgrade head` once), `api`, `worker` (Celery), `web` (nginx + SPA, proxies `/api`),
and `caddy` (HTTPS, only with `--domain`).

If you build behind a TLS-intercepting proxy, pass its CA as a build secret:
`docker build --secret id=build_ca,src=/path/ca.pem ...`

## Local development

```bash
# backend (needs PostgreSQL + Redis running locally)
cd backend
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -r requirements.lock
export RIP_DATABASE_URL=postgresql+psycopg://rip:rip@localhost:5432/rip
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload                          # http://localhost:8000/api/v1/docs
.venv/bin/celery -A app.worker.celery_app worker -Q rip -l info  # or RIP_CELERY_EAGER=true for inline jobs

# tests (use a throwaway database: the suite drops and recreates its schema)
RIP_DATABASE_URL=postgresql+psycopg://rip:rip@localhost:5432/rip_test .venv/bin/pytest -q
.venv/bin/ruff check app tests

# frontend
cd ../frontend && npm ci && npm run dev    # http://localhost:5173 (proxies /api to :8000)
npm run typecheck && npm test && npm run build
```

## Workflow

1. **Sign in and create a project.** Roles are owner / admin / editor / viewer, enforced on the server.
2. **Search.** Set up the query, keywords, synonyms, boolean query, dates, languages, document types,
   inclusion/exclusion criteria, sources, limits and PDF mode. The original query is stored separately
   from the deterministic expansion. Searches run as durable Celery jobs with SSE progress, cancel,
   retry and resume-from-cursor.
3. **Discovery records vs. collected corpus.** Search hits are metadata-only *discovery records*. A paper
   joins the *collected corpus* only after a PDF from a permitted location (open licence or OA
   repository copy) or an attested upload passes validation.
4. **Import.** DOI lists (resolved through the connectors), BibTeX, RIS and CSV. Records are deduplicated
   by DOI, then provider ID, then checksum, then a conservative title/author/year match. Anything else
   goes to manual review. Preprints are linked to their published versions, never merged.
5. **Process.** PyMuPDF extracts page-linked chunks (page index, printed page label, section, character
   offsets, bounding boxes), followed by chunk embeddings.
6. **Inspect.** The paper view shows rendered PDF pages with highlighted passages, extracted text,
   lexical term matches, saved evidence, provenance, access basis, checksum, conflicts and corrections.
7. **Rank.** `rank-v1`: BM25 plus embedding similarity plus optional recency. Missing components are
   excluded and the remaining weights renormalised. Every score shows its components, effective
   weights, coverage, version and snapshot.
8. **Visualize.** A Plotly 2D/3D scatter, linked to the library selection, with axis, unit, transform and
   missing-value disclosure. It falls back to 2D when WebGL isn't available.
9. **Export.** A CSV or JSON ZIP with `manifest.json` (queries, runs, filters, ranking, missing-data
   definitions) and a README. Formula injection is neutralised and PDFs are never included.

## Documentation

| Document | Contents |
|---|---|
| [USER_GUIDE_TH.md](docs/USER_GUIDE_TH.md) | User guide (Thai) |
| [STATUS.md](docs/STATUS.md) | Verified status per requirement, test results, smoke test report, known limitations, deferrals |
| [CONNECTORS.md](docs/CONNECTORS.md) | Connector capability matrix, verification state, how to verify live |
| [DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) | Tables, fields, states, missing-data reasons |
| [RANKING.md](docs/RANKING.md) | Ranking formulas and missing-data handling |
| [RIGHTS_POLICY.md](docs/RIGHTS_POLICY.md) | What may be fetched, stored, processed and exported |
| [PROVENANCE_POLICY.md](docs/PROVENANCE_POLICY.md) | How each artefact is traced |
| [SECURITY.md](docs/SECURITY.md) | Auth, RBAC, secrets, SSRF, upload and export safety |
| [OPERATIONS.md](docs/OPERATIONS.md) | Deployment, backup/restore, retention and deletion, job recovery |
| [openapi.json](docs/openapi.json) | Generated API schema (live at `/api/v1/docs`) |
