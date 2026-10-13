# Security policy

## Identity

- Accounts use email and password. Passwords are hashed with Argon2id (`argon2-cffi`) and must be at
  least 10 characters. Failed logins are written to the audit log.
- Access tokens are HS256 JWTs signed with `RIP_SECRET_KEY` and expire after
  `RIP_ACCESS_TOKEN_MINUTES` (60). The app refuses to start in production with the development key.
- To use an institutional IdP, replace `security.decode_token` with OIDC token verification. The rest
  of the app depends only on `deps.current_user`.
- Set `RIP_ALLOW_REGISTRATION=false` to close self-registration. Users can then be created with
  `python -m app.cli create-user`.

## Authorisation

Each project's role is checked on the server for every request (`deps.require_role`):

| Action | viewer | editor | admin | owner |
|---|---|---|---|---|
| Read papers, evidence, PDFs, analytics, rankings, jobs; export | ✓ | ✓ | ✓ | ✓ |
| Search, import, upload, collect, rank, annotate, correct, resolve duplicates, cancel/retry jobs | | ✓ | ✓ | ✓ |
| Manage members, edit project, read the audit log | | | ✓ | ✓ |
| Grant or remove owners, delete the project | | | | ✓ |

Non-members get a **404** (not 403), so they can't tell whether a project exists. A project always
keeps at least one owner. Resources reached by ID (`/searches/{id}`, `/jobs/{id}`, `/exports/{id}`)
are checked through their owning project.

## Secrets

All secrets come from environment variables (`RIP_*`; see `.env.example`). No credentials are hard-coded.
API keys are removed from stored request parameters. `.env` is git-ignored.

## Outbound fetching (SSRF)

`services/netsafe.py`:

- Only http and https on ports 80/443. No credentials in URLs.
- The hostname is resolved and **every** address must be public. This rejects private, loopback,
  link-local (including cloud metadata `169.254.169.254`), multicast, reserved and IPv4-mapped forms.
- Redirects are followed manually (at most `RIP_PDF_MAX_REDIRECTS`), and every hop is re-validated.
- The connection is pinned to the validated IP, with SNI and the Host header set to the original name,
  to defeat DNS rebinding.
- Streaming is capped at `RIP_PDF_MAX_BYTES`, with timeouts and an overall time budget.

## Uploads and PDF validation

- Uploads are size-capped while streaming.
- Content must start with a `%PDF-` signature within the first 1 KB. HTML or XML sniffing rejects
  disguised login pages.
- The file must open in PyMuPDF, must not be encrypted, must have at least 1 page, and page 1 must be
  readable.
- SHA-256 checksums are used for deduplication and integrity.

## Exports

- CSV cells beginning with `= + - @`, tab, CR or LF (including full-width variants) are prefixed with
  `'`. Every cell is quoted.
- Exports are built server-side, scoped to the project, and downloads are written to the audit log.

## Transport and headers

- The API sends `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
  `X-Frame-Options: SAMEORIGIN`. nginx adds a CSP.
- CORS is restricted to `RIP_CORS_ORIGINS`.
- Terminate TLS in front of `web` in production.

## Known limitations

- The SSE endpoint accepts `?access_token=`, because EventSource can't send headers. Tokens are
  short-lived, but URLs may end up in proxy logs. Prefer the polling fallback, or a cookie session,
  if that matters for your deployment.
- There is no login rate limiting in Phase 1. Put the API behind a reverse proxy rate limit, or an
  IdP that provides one.
- CSP allows `'unsafe-eval'`, which Plotly's WebGL traces need.
