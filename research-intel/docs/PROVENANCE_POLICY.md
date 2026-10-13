# Provenance policy

Every artefact can be traced back to its source, retrieval context, access basis, processing version and history.

| Artefact | Where its provenance lives |
|---|---|
| Search | `searches`: original query (never modified), deterministic expansion (`expanded_query` with version `deterministic-v1` and basis), all filters and criteria, sources, limits, creator |
| Search run | `search_runs`: one per (job, source). Exact query sent, request params (secrets removed), filters, start and completion time, cursor and pages, total available, retrieved / new / duplicate / excluded / failed counts, partial-coverage flag, errors, connector version |
| Metadata field | `source_observations`: one immutable row per provider response per paper (normalised and raw payload, source record ID, run, exact query, retrieval time, dedup basis). The canonical value on `papers` is the first value supplied; later differing values go into `papers.conflicts[field]` with their source |
| Missing value | `papers.missing_reasons[field]`, e.g. `not_provided_by_source`, `not_deposited_by_publisher`, `not_in_import_file`, `doi_lookup_failed_or_connectors_unavailable` |
| User edit | `user_corrections`: field, old and new value, reason, user, timestamp. Provider values are left unchanged |
| Duplicate decision | `source_observations.dedup_basis` (`doi`, `provider_id`, `title_author_year`, `new`); `dedup_candidates` for manual review; `paper_relations` (`preprint_of`) for linked versions |
| Access decision | `access_records`: source, URL, host type, version, licence, basis, permitted, redistributable, status, error, checked time |
| Collected PDF | `files`: SHA-256, size, page count, source URL (after redirects), basis, licence, version, validation checks, uploader, timestamp. The original bytes are kept unchanged |
| Extracted passage | `chunks`: file, 0-based page index, printed page label, section, character offsets into the page text, bounding boxes (PDF points), `extraction_version` (`pymupdf-blocks-v1`) |
| Evidence | `evidence`: chunk, page, offsets, verbatim quote copied from the chunk text (never typed by hand), note, user |
| Embedding | `embeddings`: provider, model, dimension, SHA-256 of the embedded text |
| Ranking score | `rankings` + `ranking_scores` (see RANKING.md) |
| Visualisation point | `/analytics` returns `paper_id`, the dimension definitions (unit, transform), the ranking snapshot ID and version, the embedding model, PCA explained variance and missing counts |
| Export | `exports` + `manifest.json`: scope, searches, runs, ranking, missing-data definitions, rights statement, generator and time. The download is written to the audit log |
| Mutations | `audit_logs`: user, project, action, entity, details, IP, time |

## Fixtures and demo data

Synthetic data is labelled at every level:

- `projects.is_fixture` and `papers.is_fixture`
- `[FIXTURE]` in titles
- the `10.5555` test DOI prefix
- a `_fixture_notice` in the fixture files
- banners in the UI
- `contains_fixture_records` in export manifests

The system never presents invented records, evidence, judgements or forecasts as live results.
