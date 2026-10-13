# Ranking: `rank-v1`

Ranking is a **discovery heuristic**. It is not a measure of quality, impact or truth. Citation counts,
journal metrics, and author or organisation reputation are deferred and are **never estimated**: a
request that includes them is rejected (HTTP 422).

## Inputs

| Input | Source |
|---|---|
| Query | Request `query`, or the project research question if none is given |
| Weights | Default `{lexical: 0.6, semantic: 0.4, recency: 0.0}`; any non-negative values |
| Paper text basis | `full_text` (collected and chunked), `title_abstract`, or `none` |
| Embedding model | `RIP_EMBEDDING_PROVIDER`: `hashing-v1` (default) or a sentence-transformers model |

## Components (each in [0, 1] within the snapshot)

**Lexical.** Okapi BM25 with k1 = 1.2 and b = 0.75. Query terms are lower-cased word tokens, with stop
words and the boolean operators AND/OR/NOT removed. Documents are title + abstract, plus all chunk
text for collected papers.

```
idf(t)   = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))
bm25(d)  = Σ_t idf(t) · tf(t,d)·(k1+1) / (tf(t,d) + k1·(1 − b + b·|d|/avgdl))
lexical  = bm25(d) / max_d bm25(d)              (0 if the maximum is 0)
```

**Semantic.** `max(cos(q, e_title_abstract), max_chunk cos(q, e_chunk))`, clipped to [0, 1]. The raw
cosine and the field that produced the maximum are stored.

> The default `hashing-v1` embedder is signed feature hashing of word uni- and bi-grams. It measures
> **lexical overlap, not meaning**, and is labelled `is_semantic: false` in every ranking, in the
> analytics payload and in the UI. Set `RIP_EMBEDDING_PROVIDER=sentence-transformers` for real
> semantic similarity.

**Recency** (optional). `(year − min_year) / (max_year − min_year)` across the snapshot, or 1.0 when all
years are equal.

## Composite

```
configured   = {k : w_k > 0}
available    = {k ∈ configured : component k has a value for this paper}
eff_w_k      = w_k / Σ_{j∈available} w_j      for k ∈ available, else 0
score        = Σ_{k∈available} eff_w_k · value_k
coverage     = Σ_{k∈available} w_k / Σ_{k∈configured} w_k
score = null, coverage = 0   when `available` is empty
```

## Missing-data rules

| Situation | Effect |
|---|---|
| No title, abstract or full text | lexical and semantic are `null` (reason `no_text`), so score is `null` and rank is `null` (sorted last) |
| No publication year | recency is `null` (reason `publication_year_missing`); remaining weights are renormalised |
| No query terms after stop-word removal | lexical is `null` (reason `no_query_terms`) |

## Reproducibility

Each snapshot (`rankings` row) stores the version, query, weights, BM25 parameters, query terms,
embedding provider and model, paper count and timestamp. Each `ranking_scores` row stores the score,
rank, component values and raw values, effective weights, coverage and text basis. Ties are broken by
`paper_id`. The test suite checks that two snapshots taken from identical inputs produce identical
scores and ranks.
