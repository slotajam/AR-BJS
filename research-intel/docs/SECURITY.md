# Security policy

## Identity

- Accounts use email and password. Passwords are hashed with Argon2id (`argon2-cffi`) and must be at
  least 10 characters. Failed logins are written to the audit log.
- Failed sign-ins are throttled in Redis (shared by all API processes): after
  `RIP_LOGIN_MAX_FAILURES` (10) failures for an email, or 5× that from one IP, within
  `RIP_LOGIN_WINDOW_SECONDS` (15 min), login returns 429 with `Retry-After`, even when the password is
  correct. A successful login clears the email's counter. Throttled attempts are audited as
  `user.login_throttled`. nginx accepts `X-Forwarded-For` only from the Docker network and
  127.0.0.1 (the Caddy front end or a host proxy) and passes the resulting client address on, so the
  per-IP limit can't be dodged by sending a fake header. The API container is never published.
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
- TLS: `./rip.sh start --domain …` adds a Caddy front end with automatic Let's Encrypt
  certificates, HTTP→HTTPS redirect and HSTS. Without it, the app listens on `127.0.0.1:8080` only;
  put your own TLS proxy in front.
- Live job progress (SSE) is authenticated with a **stream ticket**: `POST /jobs/{id}/events-ticket`
  returns a token valid for 60 s and for that one job only. The long-lived access token never appears
  in a URL.

## Remaining limitations

- The access token is kept in `sessionStorage`, so an XSS bug could read it. nginx's CSP limits
  script sources to the app's own origin.
- CSP allows `'unsafe-eval'`, which Plotly's WebGL traces need.
