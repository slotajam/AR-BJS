# Rights policy

## Principles

1. **Public accessibility is not permission.** A URL that happens to be reachable is not, on its own, a
   reason to download, store or redistribute a file.
2. **Every collected file has a recorded access basis.** If there is no basis, there is no collection.
3. **Access controls are never bypassed.** No paywall, CAPTCHA or authentication circumvention, no
   credential sharing, and no scraping of providers that don't permit it.
4. **Phase 1 exports never contain PDFs.**

## Automated acquisition (`services/access.py`)

| Provider-reported location | Access basis | Fetched? | Redistributable? |
|---|---|---|---|
| PDF URL with an open licence (Creative Commons or public domain) for that version | `oa_license` | yes | yes (subject to the licence terms) |
| PDF URL on a **repository** host flagged OA, licence unknown | `oa_repository` | yes, for private analysis | **no** |
| Free-to-read publisher copy with no licence ("bronze") | none | **no**, marked `access_restricted` | no |
| Not OA, or a TDM/publisher licence only | none | **no**, marked `access_restricted` | no |
| No PDF URL | none | no, marked `unavailable` | no |

Fetches go through the SSRF-safe client (see SECURITY.md). Responses of 401, 402 or 403 are recorded as
`fetch_failed: access controlled; not bypassed`. HTML returned in place of a PDF (a login or paywall
page) is rejected as `invalid_pdf`.

## Uploads

Every upload needs an explicit attestation (`rights_attested=true`) and one of the following bases:

| Basis | Meaning | Redistributable |
|---|---|---|
| `user_upload_own_work` | The uploader is an author or rights holder | no (unless separately licensed) |
| `user_upload_open_license` | The PDF carries an open licence (licence field recorded) | yes, if a licence is given |
| `user_upload_licensed_access` | Obtained through access licensed to the uploader for private research | **no** |

The attestation, uploader, basis, licence, version and checksum are stored and written to the audit log.

## Storage and access

- PDFs are kept in private object storage (S3/MinIO with SSE-AES256, or a local directory in
  development), keyed by project and SHA-256.
- PDFs and rendered pages are served only to project members (`viewer` and above), with
  `Cache-Control: private, no-store`.
- Only collected papers enter full-text indexing, chunking, evidence and chunk embeddings.

## Exports

- No PDF bytes are exported. Exports include the checksum, source URL, access basis, licence and
  version, so that copies can be re-acquired and verified.
- `manifest.json` records `rights.pdfs_included = false`.
