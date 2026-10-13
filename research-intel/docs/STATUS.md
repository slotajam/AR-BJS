# Phase 1 status report

Report date: 2026-10-13. Each item is classified by **verified behaviour** (automated tests or the smoke
runs described below), not by how the UI looks.

Legend: ✅ complete and tested · 🟨 implemented but credential/network-blocked · 🟨 partially implemented · ⏸ deferred · ❌ failed or blocked

## Summary

| Area | Status | Evidence |
|---|---|---|
| End-to-end workflow (project → search → review → collect/upload → process → evidence → rank → visualize → export) | ✅ with fixture/mocked providers · 🟨 live providers | `test_pdf_pipeline`, `test_ranking_exports`; UI smoke run (below) |
| Live OpenAlex / Crossref | 🟨 **network-blocked**: implemented, never verified live | The sandbox egress proxy returns 403 for both hosts (recorded in search runs). See CONNECTORS.md |

## Detailed status

### Accounts, projects, authorisation
| Item | Status | Verified by |
|---|---|---|
| Sign-in (Argon2id, expiring JWT) and registration | ✅ | `test_password_policy_and_duplicate_email`, `test_unauthenticated_requests_rejected` |
| Project creation and listing | ✅ | `test_project_isolation` |
| Roles owner/admin/editor/viewer, enforced on the server | ✅ | `test_viewer_is_read_only`, `test_owner_can_delete_project_and_its_files` |
| Project isolation (404 for non-members) | ✅ | `test_project_isolation`, `test_viewer_can_export_but_not_mutate` |
| Audit logging of mutations | ✅ | `test_last_owner_cannot_be_demoted_and_audit_logged` |
| Secrets from environment only; production refuses the dev key | ✅ | `config.get_settings`; nothing hard-coded |
| Production identity provider (OIDC) | ⏸ | A hook is documented in SECURITY.md |

### Search configuration and jobs
| Item | Status | Verified by |
|---|---|---|
| Query, keywords, synonyms, boolean, dates, languages, types, criteria, sources, limits, PDF mode | ✅ | `test_search_runs_with_provenance_dedup_and_exclusions` |
| Original query stored separately from the deterministic expansion | ✅ | same test; `test_deterministic_expansion` |
| AI query expansion rejected (deferred) | ✅ / ⏸ | `test_ai_expansion_rejected` |
| Async jobs with stage, progress and polling | ✅ | search and collect tests |
| SSE progress stream | ✅ | `test_sse_progress_stream` |
| Cancel | ✅ | `test_cancel_queued_job` |
| Retry and resume from cursor checkpoint (no re-fetching) | ✅ | `test_retry_resumes_from_checkpoint_without_refetching` |
| Durable across worker restarts (acks_late re-delivery) | ✅ | `test_redelivery_after_worker_crash_resumes_from_checkpoint` |
| Idempotency keys | ✅ | `test_idempotency_key_returns_same_job` |
| Per-run provenance (exact query, filters, timestamps, pagination, counts, partial coverage) | ✅ | search tests; manifest assertions |
| A failed connector doesn't block the others | ✅ | `test_one_failing_connector_does_not_block_others` |

### Connectors
| Item | Status | Verified by |
|---|---|---|
| OpenAlex: discovery, IDs, metadata, affiliations, citation counts, access locations | 🟨 network-blocked (✅ against fixtures) | `test_openalex_parse_preserves_only_supplied_values`, search tests |
| Crossref: same | 🟨 network-blocked (✅ against fixtures) | `test_crossref_parse_strips_jats_and_maps_versions`, search tests |
| Per-provider query translation (Crossref has no boolean syntax) | ✅ | `test_query_building_per_provider` |
| Timeouts, bounded retries, backoff, Retry-After | ✅ | `test_retry_after_and_rate_limit`, `test_server_errors_retry_then_succeed` |
| States: available / unconfigured / disabled / rate_limited / error | ✅ | `test_status_states`, `test_disabled_connector_is_skipped` |
| Documentation URL, auth, limits, pagination and capabilities recorded | ✅ | `/connectors/status`; CONNECTORS.md |
| Verification date | ❌ blocked | Live verification couldn't run here. `verified_on` is deliberately `null` |

### Discovery vs. corpus, PDFs and rights
| Item | Status | Verified by |
|---|---|---|
| Separate discovery records and collected corpus | ✅ | search tests (`in_corpus` false), collect test |
| Access states, all 8 | ✅ | search, collect, restricted and upload tests |
| Processing states (queued → … → ready / needs_review / failed) | ✅ | collect and upload tests |
| Permitted OA acquisition (open licence / OA repository) | ✅ (mocked web) | `test_collect_permitted_pdf_end_to_end`, `test_search_with_permitted_oa_mode_auto_collects` |
| Bronze / TDM / closed copies never fetched | ✅ | `test_restricted_and_disguised_pdfs_never_enter_corpus` |
| Uploads need an attested access basis | ✅ | `test_upload_requires_attestation_and_dedups_by_checksum` |
| Signature, size, readability, page count, HTML-disguised-as-PDF | ✅ | `test_pdf_validation_rules` |
| SHA-256, original preserved, no duplicate acquisition | ✅ | collect test (`File` count = 1, no second fetch) |
| SSRF: scheme, port, credentials, private/metadata IPs, DNS rebinding, redirect revalidation, size cap | ✅ | `test_ssrf_blocked[*]`, `test_redirect_*`, `test_size_cap_enforced_while_streaming` |
| Private S3/MinIO storage (SSE) and local storage | ✅ (moto S3) | `test_s3_storage_private_encrypted_roundtrip`, `test_local_storage_rejects_path_traversal` |

### Normalisation and deduplication
| Item | Status | Verified by |
|---|---|---|
| Nulls kept, each with a reason | ✅ | parse tests; `missing_reasons` assertions |
| DOI → provider ID → checksum → conservative title/author/year → manual review | ✅ | search, import and upload tests |
| Conflicting provider values preserved | ✅ | `merged.conflicts["venue"]` assertions |
| User corrections stored separately, with audit | ✅ | `test_user_corrections_stored_separately` |
| Preprint ↔ published linked, not merged | ✅ | search test (`preprint_of`) |
| Manual merge keeps per-source observations | ✅ | `test_doi_import_uses_connectors_and_ambiguous_titles_go_to_review` |

### Parsing and evidence
| Item | Status | Verified by |
|---|---|---|
| PyMuPDF page-linked chunks: page index, printed label, section, offsets, bboxes, version | ✅ | `test_parsing_produces_page_linked_chunks` |
| Evidence: saved quotes validated against chunk offsets; lexical term matches labelled as not AI claims | ✅ | collect test; UI smoke |
| Paper view: rendered pages with highlights, text, provenance, access, checksum, notes, conflicts | ✅ | UI smoke (`docs/screenshots/7-viewer.png`) |
| Unsupported content labelled (tables, equations, supplements, references, OCR) | ✅ | API `unsupported_content`; UI banner |
| Scanned PDFs with no text layer → `needs_review` (OCR deferred) | ✅ | `test_scanned_pdf_without_text_needs_review` |

### Ranking, library, visualisation
| Item | Status | Verified by |
|---|---|---|
| Lexical BM25 + embedding similarity + optional recency; versioned and reproducible | ✅ | `test_ranking_transparent_reproducible_and_missing_aware`, `test_bm25_prefers_matching_docs` |
| Missing components excluded, weights renormalised, coverage reported, null when nothing is available | ✅ | `test_compose_excludes_missing_and_renormalises` and ranking test |
| Deferred metrics rejected, never estimated | ✅ | ranking test (`citations` weight → 422) |
| Semantic similarity using a real semantic model | 🟨 partial | Default is the `hashing-v1` lexical proxy (offline), disclosed as `is_semantic:false`. The sentence-transformers provider is implemented but untested here (model download needs network) |
| pgvector storage | ✅ | Full suite passed with `RIP_PGVECTOR_ENABLED=true` against `pgvector/pgvector:0.8.0-pg16` (`vector(384)`). Similarity is computed in Python; there is no ANN index yet |
| Library: server-side paging, sorting, filtering, search, bulk select, discovery/collected badges | ✅ | `list_papers` assertions; UI smoke |
| 2D/3D Plotly with linked selection, hover, zoom, reset, drill-down, 2D fallback, disclosure | ✅ | `viz.test.ts`; analytics assertions; UI smoke (`4-visualize.png`) |

### Exports
| Item | Status | Verified by |
|---|---|---|
| CSV and JSON ZIP with manifest and README | ✅ | `test_exports_are_scoped_provenance_rich_and_rights_aware` |
| Scope accuracy (IDs, record type, excluded) | ✅ | same test |
| Formula injection neutralised | ✅ | `test_csv_formula_injection_neutralised`, plus an end-to-end tag case |
| PDFs never included | ✅ | ZIP member assertions; `rights.pdfs_included=false` |

### Delivery
| Item | Status | Verified by |
|---|---|---|
| Alembic migration matches the models | ✅ | `alembic check` → "No new upgrade operations detected" |
| Lockfiles | ✅ | `backend/requirements.lock` (uv), `frontend/package-lock.json` |
| Docker Compose | ✅ (MinIO stubbed) | Images built; stack healthy; API smoke through nginx (below) |
| OpenAPI docs | ✅ | `/api/v1/docs`; `docs/openapi.json` |
| CI workflow | 🟨 | `.github/workflows/research-intel-ci.yml` added. Every step passes locally, but it hasn't run on GitHub yet |

## Test results (2026-10-13)

```
backend  pytest (PostgreSQL 16, JSON vectors)      56 passed      coverage 89%
backend  pytest (pgvector 0.8.0, vector(384))       56 passed
backend  ruff check app tests                       clean
backend  alembic check                              no drift
frontend tsc -b                                     clean
frontend vitest                                     3 passed
frontend vite build                                 ok (Plotly split into a lazy chunk)
```

## Smoke test report

1. **Live stack (uvicorn + Celery worker on Redis + vite preview), driven with headless Chromium/Playwright:**
   - Signed in and opened the `[FIXTURE]` sample project: 5 discovery rows, banner shown.
   - Ran a live search: the job ended **failed**. Both runs recorded `ConnectorError … 403 Forbidden`
     (egress policy), with no fabricated results.
   - Uploaded a PDF with attestation: the process job **succeeded** and the paper showed `user_uploaded / ready`.
   - Computed a ranking (rank-v1) and ran a CSV export (ready).
   - Visualisation in 3D (WebGL via SwiftShader) disclosed "Plotted 5 of 6; 1 missing publication year".
   - Paper view: a term match jumped to PDF p.2 (printed 13) with 2 highlighted bounding boxes. Saving a
     text selection as evidence worked.
   - No JavaScript page errors.
2. **Docker Compose** (backend and web images built; Postgres = pgvector image; MinIO replaced with local
   storage because its images couldn't be pulled here):
   - All services healthy.
   - Through nginx: register, project, upload → **Celery container processed it**, ranking
     (`full_text`, 0.73), export ready.
   - Live search failed with a DNS error inside the containers (no egress), and that was correctly recorded.

## Known limitations

- **Connectors not live-verified** (see above). Field mappings follow the documented response shapes.
  Run `verify-connectors` before relying on them.
- The default embedder is a lexical hashing proxy, not semantic. Similarity is a brute-force numpy
  scan, which is fine for project-sized corpora (thousands of papers) but has no ANN index.
- MinIO wiring in Compose was not exercised end-to-end. The S3 backend is tested against moto.
- Uploads are buffered in memory up to `RIP_PDF_MAX_BYTES` (50 MB default).
- Section labels are heuristic (heading keywords). Printed page labels appear only if the PDF defines them.
- SSE uses a token in the query string. There is no login rate limiting (see SECURITY.md).
- The tag filter in the library applies after pagination (tags are a JSON column).
- The Plotly bundle is large (~1.4 MB gzip) but lazy-loaded on the Visualize tab.
- No per-file deletion endpoint yet (project deletion only).

## Deferred to later phases (not implemented)

**Phase 2:** Semantic Scholar, Unpaywall, arXiv, PubMed/PMC · OCR, GROBID, tables, equations,
references, citation extraction · verified journal/author metrics · screening workflow (the column
exists as a placeholder) · evidence matrix · TRL rubric · AI classification, summaries (Thai/English),
evidence claims, LLM query expansion · Excel/BibTeX/RIS/PDF-ZIP/chart exports · OIDC.

**Phase 3:** citation, co-author and institution networks · co-citation, bibliographic coupling ·
topic clustering · country analytics · emerging keywords · Technology Development Envelope · Delphi
workflows · roadmapping · commercial connectors · distributed scaling.

Google Scholar automation is not planned (no official API).
