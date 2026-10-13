# Data dictionary

Generated from the SQLAlchemy models (`backend/app/models.py`); the Alembic migration `0001` creates the same schema
(`alembic check` passes). JSON columns are JSONB on PostgreSQL. `embeddings.vector` is `vector(384)` when
`RIP_PGVECTOR_ENABLED=true`, otherwise a JSONB float array.

## Enumerations

| Field | Values |
|---|---|
| `papers.access_status` | `not_checked` · `permitted_available` · `access_restricted` · `unavailable` · `fetch_failed` · `invalid_pdf` · `collected` · `user_uploaded` |
| `papers.processing_status` | `null` (never collected) · `queued` · `downloading` · `validating` · `parsing` · `extracting` · `embedding` · `ready` · `needs_review` (no extractable text; OCR deferred) · `failed` · `cancelled` |
| `papers.in_corpus` | `false` = discovery record (metadata only) · `true` = collected corpus (validated, authorised PDF) |
| `papers.origin` | `search` · `import` · `upload` |
| `papers.screening_status` | `not_screened` · `include` · `exclude` · `maybe` (placeholder for Phase 2 screening) |
| `jobs.kind` | `search` · `collect` · `process` · `import` · `export` |
| `jobs.status` | `queued` · `running` · `succeeded` · `partial` · `failed` · `cancelled` |
| `search_runs.status` | `queued` · `running` · `completed` · `partial` · `failed` · `cancelled` · `skipped` |
| `access_records.access_basis` | `oa_license` · `oa_repository` · `user_upload_own_work` · `user_upload_open_license` · `user_upload_licensed_access` · `none` |
| `memberships.role` | `owner` · `admin` · `editor` · `viewer` |
| `source_observations.dedup_basis` | `new` · `doi` · `provider_id` · `title_author_year` |
| `paper_relations.relation` | `preprint_of` |
| `dedup_candidates.status` | `pending` · `merged` · `distinct` |

## Missing-data reasons (`papers.missing_reasons`)

| Reason | Meaning |
|---|---|
| `not_provided_by_source` | The provider record had no value |
| `not_deposited_by_publisher` | Crossref: the publisher did not deposit the field (e.g. abstract) |
| `not_reported_on_crossref_work_record` | Crossref work records don't carry this field (retraction) |
| `not_in_import_file` | The imported BibTeX/RIS/CSV record lacked the field |
| `not_supplied_with_upload` | No metadata was given with an upload |
| `doi_lookup_failed_or_connectors_unavailable` | DOI import could not be resolved |

Unavailable metrics (h-index, impact factor, quartiles…) do not exist as columns in Phase 1; they are never estimated.

## Tables


### `audit_logs`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | yes |  |
| `user_id` | VARCHAR(36) | yes |  |
| `action` | VARCHAR(100) | no |  |
| `entity_type` | VARCHAR(50) | no |  |
| `entity_id` | VARCHAR(36) | yes |  |
| `details` | JSONB | no |  |
| `ip` | VARCHAR(64) | yes |  |
| `created_at` | DATETIME | no |  |

### `connector_state`

| Column | Type | Null | Notes |
|---|---|---|---|
| `name` | VARCHAR(40) | no | PK |
| `last_checked_at` | DATETIME | yes |  |
| `last_success_at` | DATETIME | yes |  |
| `last_error` | TEXT | yes |  |
| `last_error_at` | DATETIME | yes |  |
| `rate_limited_until` | DATETIME | yes |  |

### `users`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `email` | VARCHAR(320) | no | unique |
| `display_name` | VARCHAR(200) | no |  |
| `password_hash` | VARCHAR(255) | no |  |
| `is_active` | BOOLEAN | no |  |
| `created_at` | DATETIME | no |  |

Unique index `ix_users_email`: (email)

### `projects`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `name` | VARCHAR(300) | no |  |
| `description` | TEXT | yes |  |
| `research_question` | TEXT | yes |  |
| `is_fixture` | BOOLEAN | no |  |
| `created_by` | VARCHAR(36) | no | FK → users.id |
| `created_at` | DATETIME | no |  |
| `updated_at` | DATETIME | no |  |

### `exports`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | no | FK → projects.id |
| `job_id` | VARCHAR(36) | yes |  |
| `format` | VARCHAR(10) | no |  |
| `scope` | JSONB | no |  |
| `status` | VARCHAR(20) | no |  |
| `storage_key` | TEXT | yes |  |
| `row_count` | INTEGER | yes |  |
| `manifest` | JSONB | no |  |
| `error` | TEXT | yes |  |
| `created_by` | VARCHAR(36) | no | FK → users.id |
| `created_at` | DATETIME | no |  |

### `jobs`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | no | FK → projects.id |
| `kind` | VARCHAR(30) | no |  |
| `status` | VARCHAR(20) | no |  |
| `stage` | VARCHAR(40) | no |  |
| `progress` | FLOAT | no |  |
| `idempotency_key` | VARCHAR(200) | yes |  |
| `params` | JSONB | no |  |
| `state` | JSONB | no |  |
| `result` | JSONB | no |  |
| `error` | TEXT | yes |  |
| `attempts` | INTEGER | no |  |
| `cancel_requested` | BOOLEAN | no |  |
| `created_by` | VARCHAR(36) | yes | FK → users.id |
| `created_at` | DATETIME | no |  |
| `started_at` | DATETIME | yes |  |
| `finished_at` | DATETIME | yes |  |
| `updated_at` | DATETIME | no |  |

Unique: (project_id, kind, idempotency_key)

### `memberships`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | no | FK → projects.id |
| `user_id` | VARCHAR(36) | no | FK → users.id |
| `role` | VARCHAR(20) | no |  |
| `created_at` | DATETIME | no |  |

Unique: (project_id, user_id)

### `papers`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | no | FK → projects.id |
| `doi` | VARCHAR(300) | yes |  |
| `title` | TEXT | yes |  |
| `abstract` | TEXT | yes |  |
| `publication_year` | INTEGER | yes |  |
| `publication_date` | VARCHAR(10) | yes |  |
| `venue` | TEXT | yes |  |
| `document_type` | VARCHAR(60) | yes |  |
| `language` | VARCHAR(20) | yes |  |
| `keywords` | JSONB | no |  |
| `license` | VARCHAR(200) | yes |  |
| `is_retracted` | BOOLEAN | yes |  |
| `cited_by_count` | INTEGER | yes |  |
| `access_status` | VARCHAR(30) | no |  |
| `processing_status` | VARCHAR(20) | yes |  |
| `in_corpus` | BOOLEAN | no |  |
| `origin` | VARCHAR(20) | no |  |
| `missing_reasons` | JSONB | no |  |
| `conflicts` | JSONB | no |  |
| `tags` | JSONB | no |  |
| `screening_status` | VARCHAR(20) | no |  |
| `excluded` | BOOLEAN | no |  |
| `exclusion_reason` | TEXT | yes |  |
| `is_fixture` | BOOLEAN | no |  |
| `created_at` | DATETIME | no |  |
| `updated_at` | DATETIME | no |  |

Unique index `uq_paper_project_doi`: (project_id, doi) where doi is not null

### `rankings`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | no | FK → projects.id |
| `version` | VARCHAR(40) | no |  |
| `query` | TEXT | no |  |
| `weights` | JSONB | no |  |
| `params` | JSONB | no |  |
| `paper_count` | INTEGER | no |  |
| `created_by` | VARCHAR(36) | no | FK → users.id |
| `snapshot_at` | DATETIME | no |  |

### `searches`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | no | FK → projects.id |
| `name` | VARCHAR(300) | no |  |
| `original_query` | TEXT | no |  |
| `keywords` | JSONB | no |  |
| `synonyms` | JSONB | no |  |
| `boolean_query` | TEXT | yes |  |
| `date_from` | DATE | yes |  |
| `date_to` | DATE | yes |  |
| `languages` | JSONB | no |  |
| `document_types` | JSONB | no |  |
| `inclusion_criteria` | TEXT | yes |  |
| `exclusion_criteria` | TEXT | yes |  |
| `exclusion_terms` | JSONB | no |  |
| `sources` | JSONB | no |  |
| `result_limit` | INTEGER | no |  |
| `pdf_mode` | VARCHAR(30) | no |  |
| `ai_expansion_enabled` | BOOLEAN | no |  |
| `expanded_query` | JSONB | yes |  |
| `created_by` | VARCHAR(36) | no | FK → users.id |
| `created_at` | DATETIME | no |  |

### `access_records`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `source` | VARCHAR(40) | no |  |
| `url` | TEXT | yes |  |
| `landing_page_url` | TEXT | yes |  |
| `host_type` | VARCHAR(30) | yes |  |
| `version` | VARCHAR(40) | yes |  |
| `license` | VARCHAR(200) | yes |  |
| `access_basis` | VARCHAR(60) | yes |  |
| `permitted` | BOOLEAN | no |  |
| `redistributable` | BOOLEAN | no |  |
| `status` | VARCHAR(30) | no |  |
| `error` | TEXT | yes |  |
| `checked_at` | DATETIME | no |  |

### `dedup_candidates`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | no | FK → projects.id |
| `paper_a_id` | VARCHAR(36) | no | FK → papers.id |
| `paper_b_id` | VARCHAR(36) | no | FK → papers.id |
| `score` | FLOAT | no |  |
| `reason` | TEXT | no |  |
| `status` | VARCHAR(20) | no |  |
| `resolved_by` | VARCHAR(36) | yes |  |
| `created_at` | DATETIME | no |  |

### `paper_authors`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `position` | INTEGER | no |  |
| `display_name` | TEXT | no |  |
| `orcid` | VARCHAR(40) | yes |  |
| `provider_author_id` | VARCHAR(100) | yes |  |
| `affiliations` | JSONB | no |  |
| `source` | VARCHAR(40) | no |  |

### `paper_identifiers`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | no | FK → projects.id |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `scheme` | VARCHAR(30) | no |  |
| `value` | VARCHAR(300) | no |  |
| `source` | VARCHAR(40) | no |  |

Unique: (project_id, scheme, value)

### `paper_notes`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `user_id` | VARCHAR(36) | no | FK → users.id |
| `body` | TEXT | no |  |
| `created_at` | DATETIME | no |  |

### `paper_relations`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | no | FK → projects.id |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `related_paper_id` | VARCHAR(36) | no | FK → papers.id |
| `relation` | VARCHAR(30) | no |  |
| `basis` | TEXT | no |  |
| `created_at` | DATETIME | no |  |

Unique: (paper_id, related_paper_id, relation)

### `ranking_scores`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `ranking_id` | VARCHAR(36) | no | FK → rankings.id |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `score` | FLOAT | yes |  |
| `rank` | INTEGER | yes |  |
| `components` | JSONB | no |  |
| `effective_weights` | JSONB | no |  |
| `coverage` | FLOAT | no |  |
| `text_basis` | VARCHAR(20) | no |  |

Unique: (ranking_id, paper_id)

### `search_runs`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `search_id` | VARCHAR(36) | no | FK → searches.id |
| `job_id` | VARCHAR(36) | no | FK → jobs.id |
| `source` | VARCHAR(40) | no |  |
| `exact_query` | TEXT | no |  |
| `request_params` | JSONB | no |  |
| `filters` | JSONB | no |  |
| `status` | VARCHAR(20) | no |  |
| `started_at` | DATETIME | yes |  |
| `completed_at` | DATETIME | yes |  |
| `pagination` | JSONB | no |  |
| `result_limit` | INTEGER | no |  |
| `retrieved_count` | INTEGER | no |  |
| `new_count` | INTEGER | no |  |
| `duplicate_count` | INTEGER | no |  |
| `exclusion_count` | INTEGER | no |  |
| `failure_count` | INTEGER | no |  |
| `partial_coverage` | BOOLEAN | no |  |
| `errors` | JSONB | no |  |
| `connector_version` | VARCHAR(40) | no |  |

### `user_corrections`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `user_id` | VARCHAR(36) | no | FK → users.id |
| `field` | VARCHAR(60) | no |  |
| `old_value` | JSONB | yes |  |
| `new_value` | JSONB | yes |  |
| `reason` | TEXT | yes |  |
| `created_at` | DATETIME | no |  |

### `files`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | no | FK → projects.id |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `access_record_id` | VARCHAR(36) | yes | FK → access_records.id |
| `storage_key` | TEXT | no |  |
| `sha256` | VARCHAR(64) | no |  |
| `size_bytes` | INTEGER | no |  |
| `page_count` | INTEGER | yes |  |
| `content_type` | VARCHAR(100) | no |  |
| `original_filename` | TEXT | yes |  |
| `source_url` | TEXT | yes |  |
| `access_basis` | VARCHAR(60) | no |  |
| `license` | VARCHAR(200) | yes |  |
| `version` | VARCHAR(40) | yes |  |
| `redistributable` | BOOLEAN | no |  |
| `validation` | JSONB | no |  |
| `uploaded_by` | VARCHAR(36) | yes |  |
| `downloaded_at` | DATETIME | no |  |

Unique: (project_id, sha256)

### `source_observations`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `search_run_id` | VARCHAR(36) | yes | FK → search_runs.id |
| `job_id` | VARCHAR(36) | yes |  |
| `source` | VARCHAR(40) | no |  |
| `source_record_id` | VARCHAR(300) | yes |  |
| `exact_query` | TEXT | yes |  |
| `retrieved_at` | DATETIME | no |  |
| `normalized` | JSONB | no |  |
| `raw` | JSONB | no |  |
| `dedup_basis` | VARCHAR(40) | yes |  |

### `chunks`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `file_id` | VARCHAR(36) | no | FK → files.id |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `chunk_index` | INTEGER | no |  |
| `page_index` | INTEGER | no |  |
| `printed_page` | VARCHAR(20) | yes |  |
| `section_label` | TEXT | yes |  |
| `text` | TEXT | no |  |
| `char_start` | INTEGER | no |  |
| `char_end` | INTEGER | no |  |
| `bboxes` | JSONB | no |  |
| `extraction_version` | VARCHAR(40) | no |  |

Unique: (file_id, chunk_index)

### `embeddings`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `project_id` | VARCHAR(36) | no | FK → projects.id |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `chunk_id` | VARCHAR(36) | yes | FK → chunks.id |
| `kind` | VARCHAR(20) | no |  |
| `provider` | VARCHAR(40) | no |  |
| `model` | VARCHAR(200) | no |  |
| `dim` | INTEGER | no |  |
| `text_sha256` | VARCHAR(64) | no |  |
| `vector` | vector(384) / JSONB | no |  |
| `created_at` | DATETIME | no |  |

### `evidence`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | VARCHAR(36) | no | PK |
| `paper_id` | VARCHAR(36) | no | FK → papers.id |
| `chunk_id` | VARCHAR(36) | no | FK → chunks.id |
| `user_id` | VARCHAR(36) | no | FK → users.id |
| `quote` | TEXT | no |  |
| `page_index` | INTEGER | no |  |
| `char_start` | INTEGER | no |  |
| `char_end` | INTEGER | no |  |
| `note` | TEXT | yes |  |
| `created_at` | DATETIME | no |  |
