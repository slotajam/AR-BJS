"""Visualization dataset with explicit disclosure of transforms, units and missing values."""

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Embedding, Paper, RankingScore, SourceObservation
from app.services.embeddings import get_embedder
from app.services.ranking import ensure_title_abstract_embedding, latest_ranking

DIMENSIONS = {
    "publication_year": {"label": "Publication year", "unit": "year", "transform": "none", "type": "numeric"},
    "relevance_score": {"label": "Relevance score", "unit": "unitless [0,1]",
                        "transform": "composite of latest ranking snapshot", "type": "numeric"},
    "lexical": {"label": "Lexical (BM25, normalised)", "unit": "unitless [0,1]",
                "transform": "BM25 / snapshot max", "type": "numeric"},
    "semantic": {"label": "Semantic similarity", "unit": "unitless [0,1]",
                 "transform": "cosine clipped to [0,1]", "type": "numeric"},
    "embedding_pc1": {"label": "Embedding PC1", "unit": "unitless", "type": "numeric",
                      "transform": "PCA (SVD) of title/abstract embeddings, mean-centred"},
    "embedding_pc2": {"label": "Embedding PC2", "unit": "unitless", "type": "numeric",
                      "transform": "PCA (SVD) of title/abstract embeddings, mean-centred"},
    "embedding_pc3": {"label": "Embedding PC3", "unit": "unitless", "type": "numeric",
                      "transform": "PCA (SVD) of title/abstract embeddings, mean-centred"},
    "access_status": {"label": "Access status", "type": "categorical", "transform": "none"},
    "record_type": {"label": "Record type", "type": "categorical", "transform": "none"},
    "source": {"label": "First discovery source", "type": "categorical", "transform": "none"},
}


def build(db: Session, project_id: str, include_excluded: bool = False) -> dict:
    stmt = select(Paper).where(Paper.project_id == project_id).order_by(Paper.id)
    papers = list(db.scalars(stmt))
    excluded_count = sum(1 for p in papers if p.excluded)
    if not include_excluded:
        papers = [p for p in papers if not p.excluded]
    ranking = latest_ranking(db, project_id)
    scores = {}
    if ranking:
        scores = {s.paper_id: s for s in db.scalars(select(RankingScore).where(RankingScore.ranking_id == ranking.id))}
    first_source = {}
    for paper_id, source in db.execute(
        select(SourceObservation.paper_id, SourceObservation.source)
        .join(Paper, Paper.id == SourceObservation.paper_id)
        .where(Paper.project_id == project_id)
        .order_by(SourceObservation.retrieved_at)
    ):
        first_source.setdefault(paper_id, source)

    embedder = get_embedder()
    vecs, vec_ids = [], []
    for p in papers:
        e = db.scalar(select(Embedding).where(Embedding.paper_id == p.id, Embedding.kind == "title_abstract",
                                              Embedding.model == embedder.model))
        v = np.asarray(e.vector, dtype=np.float32) if e else ensure_title_abstract_embedding(db, p, embedder)
        if v is not None:
            vecs.append(v)
            vec_ids.append(p.id)
    pcs: dict[str, list[float]] = {}
    explained = None
    if len(vecs) >= 3:
        m = np.vstack(vecs)
        m = m - m.mean(axis=0)
        u, s, _ = np.linalg.svd(m, full_matrices=False)
        k = min(3, len(s))
        coords = u[:, :k] * s[:k]
        var = (s**2) / max((s**2).sum(), 1e-12)
        explained = [round(float(x), 4) for x in var[:k]]
        for pid, row in zip(vec_ids, coords, strict=True):
            pcs[pid] = [round(float(x), 6) for x in row] + [None] * (3 - k)

    points = []
    for p in papers:
        sc = scores.get(p.id)
        pc = pcs.get(p.id, [None, None, None])
        points.append({
            "paper_id": p.id,
            "title": p.title,
            "doi": p.doi,
            "publication_year": p.publication_year,
            "relevance_score": sc.score if sc else None,
            "lexical": (sc.components.get("lexical") or {}).get("value") if sc else None,
            "semantic": (sc.components.get("semantic") or {}).get("value") if sc else None,
            "embedding_pc1": pc[0], "embedding_pc2": pc[1], "embedding_pc3": pc[2],
            "access_status": p.access_status,
            "record_type": "collected" if p.in_corpus else "discovery",
            "source": first_source.get(p.id, p.origin),
            "is_fixture": p.is_fixture,
        })
    missing = {d: sum(1 for pt in points if pt[d] is None) for d in DIMENSIONS}
    return {
        "dimensions": DIMENSIONS,
        "points": points,
        "missing_counts": missing,
        "total": len(points),
        "excluded_hidden": 0 if include_excluded else excluded_count,
        "ranking": {"id": ranking.id, "version": ranking.version, "snapshot_at": ranking.snapshot_at,
                    "query": ranking.query} if ranking else None,
        "embedding": {"provider": embedder.provider, "model": embedder.model, "is_semantic": embedder.is_semantic,
                      "pca_explained_variance": explained,
                      "pca_note": None if explained else "PCA needs at least 3 papers with title/abstract text"},
        "notes": [
            "Points with a missing value on a plotted axis are omitted from that plot and counted in missing_counts.",
            "Relevance scores are a discovery heuristic, not a measure of paper quality.",
        ],
    }
