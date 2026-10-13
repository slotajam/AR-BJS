"""Transparent, versioned relevance ranking (a discovery heuristic, not a quality judgement).

rank-v1
-------
Components, each normalised to [0, 1] within the snapshot:

* lexical  – Okapi BM25 (k1=1.2, b=0.75) of query terms against the paper's text basis,
             divided by the snapshot maximum.
* semantic – cosine similarity between query and paper embeddings, clipped to [0, 1].
             For collected papers the best of title/abstract and chunk similarities is used.
* recency  – (year - min_year) / (max_year - min_year); 1.0 when all years are equal. Optional.

Text basis: ``full_text`` when the paper is in the collected corpus and has chunks,
``title_abstract`` when it has a title or abstract, otherwise ``none``.

Composite: components that are unavailable for a paper are *excluded* and the remaining
configured weights are renormalised to sum to 1. ``coverage`` = sum of available configured
weights / sum of all configured weights. If no component is available the score is null.
"""

import math
from collections import Counter

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Chunk, Embedding, Paper, Ranking, RankingScore
from app.services.embeddings import STOP, TOKEN_RE, cosine, get_embedder, text_hash

RANKING_VERSION = "rank-v1"
DEFAULT_WEIGHTS = {"lexical": 0.6, "semantic": 0.4, "recency": 0.0}
BOOLEAN_WORDS = {"and", "or", "not"}
K1, B = 1.2, 0.75


def tokenize(text: str) -> list[str]:
    return [t for t in TOKEN_RE.findall(text.lower()) if t not in STOP and t not in BOOLEAN_WORDS and len(t) > 1]


def query_terms(query: str) -> list[str]:
    seen, out = set(), []
    for t in tokenize(query):
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def bm25_scores(docs: list[list[str]], terms: list[str]) -> list[float]:
    n = len(docs)
    if n == 0 or not terms:
        return [0.0] * n
    avgdl = sum(len(d) for d in docs) / n or 1.0
    df = Counter()
    for d in docs:
        for t in set(d):
            df[t] += 1
    scores = []
    for d in docs:
        tf = Counter(d)
        s = 0.0
        for t in terms:
            if tf[t] == 0:
                continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            s += idf * tf[t] * (K1 + 1) / (tf[t] + K1 * (1 - B + B * len(d) / avgdl))
        scores.append(s)
    return scores


def title_abstract_text(p: Paper) -> str:
    return "\n".join(x for x in (p.title, p.abstract) if x)


def ensure_title_abstract_embedding(db: Session, p: Paper, embedder) -> np.ndarray | None:
    text = title_abstract_text(p)
    if not text:
        return None
    h = text_hash(text)
    e = db.scalar(
        select(Embedding).where(Embedding.paper_id == p.id, Embedding.kind == "title_abstract",
                                Embedding.model == embedder.model, Embedding.text_sha256 == h)
    )
    if e is None:
        vec = embedder.embed([text])[0]
        e = Embedding(project_id=p.project_id, paper_id=p.id, kind="title_abstract", provider=embedder.provider,
                      model=embedder.model, dim=int(vec.shape[0]), text_sha256=h, vector=vec.tolist())
        db.add(e)
    return np.asarray(e.vector, dtype=np.float32)


def compose(components: dict[str, dict], weights: dict[str, float]) -> tuple[float | None, dict, float]:
    configured = {k: w for k, w in weights.items() if w > 0}
    total = sum(configured.values())
    available = {k: w for k, w in configured.items() if components.get(k, {}).get("value") is not None}
    if not available or total == 0:
        return None, {k: 0.0 for k in configured}, 0.0
    s = sum(available.values())
    eff = {k: (available.get(k, 0.0) / s) for k in configured}
    score = sum(eff[k] * components[k]["value"] for k in available)
    return round(score, 6), {k: round(v, 6) for k, v in eff.items()}, round(s / total, 6)


def run_ranking(db: Session, project_id: str, query: str, weights: dict | None, user_id: str,
                paper_ids: list[str] | None = None) -> Ranking:
    weights = {**DEFAULT_WEIGHTS, **(weights or {})}
    for k, v in weights.items():
        if k not in DEFAULT_WEIGHTS or v < 0:
            raise ValueError(f"invalid weight {k}={v}")
    stmt = select(Paper).where(Paper.project_id == project_id).order_by(Paper.id)
    if paper_ids:
        stmt = stmt.where(Paper.id.in_(paper_ids))
    papers = list(db.scalars(stmt))
    embedder = get_embedder()
    terms = query_terms(query)
    qvec = embedder.embed([query])[0] if query.strip() else None

    bases, docs = {}, []
    chunk_text: dict[str, list[Chunk]] = {}
    for p in papers:
        chunks = list(db.scalars(select(Chunk).where(Chunk.paper_id == p.id).order_by(Chunk.chunk_index))) \
            if p.in_corpus else []
        chunk_text[p.id] = chunks
        ta = title_abstract_text(p)
        if chunks:
            bases[p.id] = "full_text"
            docs.append(tokenize(ta + "\n" + "\n".join(c.text for c in chunks)))
        elif ta:
            bases[p.id] = "title_abstract"
            docs.append(tokenize(ta))
        else:
            bases[p.id] = "none"
            docs.append([])
    raw_bm25 = bm25_scores(docs, terms)
    max_bm25 = max(raw_bm25, default=0.0)
    years = [p.publication_year for p in papers if p.publication_year]
    ymin, ymax = (min(years), max(years)) if years else (None, None)

    ranking = Ranking(project_id=project_id, version=RANKING_VERSION, query=query, weights=weights,
                      params={"bm25": {"k1": K1, "b": B}, "query_terms": terms,
                              "embedding": {"provider": embedder.provider, "model": embedder.model,
                                            "is_semantic": embedder.is_semantic}},
                      paper_count=len(papers), created_by=user_id)
    db.add(ranking)
    db.flush()

    rows = []
    for p, raw in zip(papers, raw_bm25, strict=True):
        basis = bases[p.id]
        comps: dict[str, dict] = {}
        if basis == "none" or not terms:
            comps["lexical"] = {"value": None, "reason": "no_text" if basis == "none" else "no_query_terms"}
        else:
            comps["lexical"] = {"value": round(raw / max_bm25, 6) if max_bm25 > 0 else 0.0, "raw_bm25": round(raw, 6),
                                "field_basis": basis}
        if basis == "none" or qvec is None:
            comps["semantic"] = {"value": None, "reason": "no_text" if basis == "none" else "empty_query"}
        else:
            sims = []
            v = ensure_title_abstract_embedding(db, p, embedder)
            if v is not None:
                sims.append(("title_abstract", cosine(qvec, v)))
            if chunk_text[p.id]:
                cvecs = db.scalars(select(Embedding).where(Embedding.paper_id == p.id, Embedding.kind == "chunk",
                                                          Embedding.model == embedder.model))
                best = max((cosine(qvec, np.asarray(e.vector)) for e in cvecs), default=None)
                if best is not None:
                    sims.append(("full_text_chunk", best))
            if sims:
                src, cos = max(sims, key=lambda x: x[1])
                comps["semantic"] = {"value": round(min(1.0, max(0.0, cos)), 6), "raw_cosine": round(cos, 6),
                                     "field_basis": src, "model": embedder.model}
            else:
                comps["semantic"] = {"value": None, "reason": "no_embedding"}
        if weights.get("recency", 0) > 0:
            if p.publication_year and ymin is not None:
                val = 1.0 if ymax == ymin else (p.publication_year - ymin) / (ymax - ymin)
                comps["recency"] = {"value": round(val, 6), "year": p.publication_year, "range": [ymin, ymax]}
            else:
                comps["recency"] = {"value": None, "reason": "publication_year_missing"}
        score, eff, coverage = compose(comps, weights)
        rows.append(RankingScore(ranking_id=ranking.id, paper_id=p.id, score=score, components=comps,
                                 effective_weights=eff, coverage=coverage, text_basis=basis))
    scored = sorted((r for r in rows if r.score is not None), key=lambda r: (-r.score, r.paper_id))
    for i, r in enumerate(scored, start=1):
        r.rank = i
    db.add_all(rows)
    db.flush()
    return ranking


def latest_ranking(db: Session, project_id: str) -> Ranking | None:
    return db.scalar(select(Ranking).where(Ranking.project_id == project_id).order_by(Ranking.snapshot_at.desc()))
