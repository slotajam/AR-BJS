# Connector capability matrix

The values in this table are recorded in code (`app/connectors/*.py`, `ConnectorInfo`) and served at
`GET /api/v1/connectors/status`, together with the runtime state.

| | OpenAlex | Crossref |
|---|---|---|
| Docs | https://docs.openalex.org/how-to-use-the-api/api-overview | https://www.crossref.org/documentation/retrieve-metadata/rest-api/ |
| Connector version | `openalex-v1` | `crossref-v1` |
| Authentication | None. `mailto` joins the polite pool; optional `api_key` (`RIP_OPENALEX_API_KEY`) | None. `mailto` selects the polite pool; optional Metadata Plus token (`RIP_CROSSREF_PLUS_TOKEN`) |
| Rate limits (as documented) | Daily request budget, about 10 req/s; HTTP 429 | Per-pool rate and concurrency limits in `X-Rate-Limit-*` headers; HTTP 429 |
| Client throttle | ≥ 0.11 s between requests | ≥ 0.2 s between requests |
| Pagination | `cursor=*` → `meta.next_cursor`, `per_page` ≤ 200 | `cursor=*` → `message.next-cursor`, `rows` ≤ 1000 |
| Boolean query | Yes (`search=` with AND/OR/NOT) | **No.** Operators are removed and NOT-terms dropped; the query actually sent is stored per run |
| Filters used | publication date range, `language`, `type` | `from-pub-date`, `until-pub-date`, `type`. Language is filtered client-side, only where the record states it |
| Discovery | ✅ | ✅ |
| Identifiers | DOI, OpenAlex ID, PMID, PMCID, MAG | DOI |
| Metadata | title, abstract (rebuilt from the inverted index), venue, dates, type, language, keywords, licence, retraction flag, cited-by count | title, abstract (JATS stripped), venue, dates, type, language, subjects, licence, cited-by count. Retraction **not** reported on work records |
| Affiliations | name, ROR, country | name only |
| Citations | `cited_by_count` (informational, not used in ranking) | `is-referenced-by-count` (informational) |
| Access locations | `best_oa_location`, `primary_location`, `locations[]` with pdf_url / licence / version / host type | `link[]` (PDF) with content-version; licence per content-version |

## Runtime states

| State | Meaning |
|---|---|
| `available` | Enabled and configured, with no recent failure |
| `unconfigured` | Required configuration missing (neither Phase 1 connector requires credentials) |
| `disabled` | `RIP_<NAME>_ENABLED=false`, or deferred to a later phase |
| `rate_limited` | A 429 was received; the state holds until `Retry-After` (or 60 s) has passed |
| `error` | The latest call failed within the last 30 minutes, with no success since |

A disabled or unconfigured connector is recorded as a `skipped` search run. A failing connector marks
its run `failed` or `partial`, and the other connectors still run.

## HTTP behaviour

- Timeouts: `RIP_HTTP_TIMEOUT_SECONDS` (20 s).
- Bounded retries: `RIP_HTTP_MAX_RETRIES` (3) on transport errors, 5xx and 429, with exponential backoff
  plus jitter.
- `Retry-After` is honoured. If it exceeds 60 s the run stops as `rate_limited`/`partial`; the user can
  resume it later from the stored cursor.
- 4xx responses (other than 404 and 429) fail immediately and are not retried.

## Verification state

**Neither connector has been verified against the live service** (`verified_on = null`). The sandbox
used for development blocks `api.openalex.org` and `api.crossref.org`; the smoke test recorded
`ConnectorError ... 403 Forbidden` from the egress proxy. Both connectors are tested against synthetic
fixtures that follow each provider's documented response shape (`backend/tests/fixtures/*.json`,
marked `_fixture_notice: FIXTURE`, using the 10.5555 test DOI prefix).

To verify live:

```bash
cd backend && RIP_CONTACT_EMAIL=you@inst.example python -m app.cli verify-connectors
# writes connector-verification.json: request params, record counts, cursor presence, DOI lookup result
```

After a successful run, set `verified_on` in the connector's `ConnectorInfo`, bump the connector
version if any parsing changed, and attach the report to the release.

## Deferred connectors

Semantic Scholar, Unpaywall, arXiv and PubMed/PMC are planned for Phase 2. Commercial databases are
planned for Phase 3. Google Scholar is **not supported**: it has no official API, and automated
scraping is not permitted.
