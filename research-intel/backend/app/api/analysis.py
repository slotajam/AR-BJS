from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import audit, current_user, require_role
from app.models import Export, Project, Ranking, RankingScore, User
from app.schemas import ExportIn, RankingIn
from app.services import analytics, ranking
from app.services.jobs import create_job, enqueue
from app.services.storage import get_storage

router = APIRouter(tags=["analysis"])


def _ranking_out(db: Session, r: Ranking, include_scores: bool = True) -> dict:
    out = {"id": r.id, "version": r.version, "query": r.query, "weights": r.weights, "params": r.params,
           "paper_count": r.paper_count, "snapshot_at": r.snapshot_at, "created_by": r.created_by,
           "formula": ranking.__doc__}
    if include_scores:
        out["scores"] = [{"paper_id": s.paper_id, "score": s.score, "rank": s.rank, "components": s.components,
                          "effective_weights": s.effective_weights, "coverage": s.coverage,
                          "text_basis": s.text_basis}
                         for s in db.scalars(select(RankingScore).where(RankingScore.ranking_id == r.id)
                                             .order_by(RankingScore.rank.asc().nulls_last(), RankingScore.paper_id))]
    return out


@router.post("/projects/{project_id}/rankings", status_code=201)
def create_ranking(project_id: str, body: RankingIn, request: Request, user: User = Depends(current_user),
                   db: Session = Depends(get_db)):
    require_role(db, user, project_id, "editor")
    project = db.get(Project, project_id)
    q = (body.query or project.research_question or "").strip()
    if not q:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Provide a query or set the research question")
    try:
        r = ranking.run_ranking(db, project_id, q, body.weights, user.id, body.paper_ids)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    audit(db, user_id=user.id, project_id=project_id, action="ranking.create", entity_type="ranking", entity_id=r.id,
          details={"query": q, "weights": r.weights, "version": r.version}, request=request)
    db.commit()
    return _ranking_out(db, r)


@router.get("/projects/{project_id}/rankings")
def list_rankings(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, user, project_id, "viewer")
    return [_ranking_out(db, r, include_scores=False) for r in
            db.scalars(select(Ranking).where(Ranking.project_id == project_id).order_by(Ranking.snapshot_at.desc()))]


@router.get("/projects/{project_id}/rankings/{ranking_id}")
def get_ranking(project_id: str, ranking_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, user, project_id, "viewer")
    r = db.get(Ranking, ranking_id)
    if r is None or r.project_id != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ranking not found")
    return _ranking_out(db, r)


@router.get("/projects/{project_id}/analytics")
def get_analytics(project_id: str, include_excluded: bool = False, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    require_role(db, user, project_id, "viewer")
    data = analytics.build(db, project_id, include_excluded)
    db.commit()  # persist any lazily computed title/abstract embeddings
    return data


@router.post("/projects/{project_id}/exports", status_code=202)
def create_export(project_id: str, body: ExportIn, request: Request, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    require_role(db, user, project_id, "viewer")  # viewers may export what they can read
    scope = {"paper_ids": body.paper_ids, "record_type": body.record_type, "include_excluded": body.include_excluded}
    if body.idempotency_key:
        from app.models import Job

        existing = db.scalar(select(Job).where(Job.project_id == project_id, Job.kind == "export",
                                               Job.idempotency_key == body.idempotency_key))
        if existing:
            return _export_out(db.get(Export, existing.params["export_id"]))
    exp = Export(project_id=project_id, format=body.format, scope=scope, created_by=user.id)
    db.add(exp)
    db.flush()
    job, _ = create_job(db, project_id=project_id, kind="export", params={"export_id": exp.id}, user_id=user.id,
                        idempotency_key=body.idempotency_key)
    exp.job_id = job.id
    audit(db, user_id=user.id, project_id=project_id, action="export.create", entity_type="export", entity_id=exp.id,
          details={"format": body.format, "scope": scope}, request=request)
    db.commit()
    enqueue(job)
    db.refresh(exp)
    return _export_out(exp)


def _export_out(e: Export) -> dict:
    return {"id": e.id, "project_id": e.project_id, "job_id": e.job_id, "format": e.format, "scope": e.scope,
            "status": e.status, "row_count": e.row_count, "error": e.error, "created_at": e.created_at,
            "manifest": e.manifest or None, "download_url": f"/api/v1/exports/{e.id}/download"
            if e.status == "ready" else None}


def _get_export(db: Session, user: User, export_id: str) -> Export:
    e = db.get(Export, export_id)
    if e is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Export not found")
    require_role(db, user, e.project_id, "viewer")
    return e


@router.get("/projects/{project_id}/exports")
def list_exports(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, user, project_id, "viewer")
    return [_export_out(e) for e in
            db.scalars(select(Export).where(Export.project_id == project_id).order_by(Export.created_at.desc()))]


@router.get("/exports/{export_id}")
def get_export(export_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _export_out(_get_export(db, user, export_id))


@router.get("/exports/{export_id}/download")
def download_export(export_id: str, request: Request, user: User = Depends(current_user),
                    db: Session = Depends(get_db)):
    e = _get_export(db, user, export_id)
    if e.status != "ready" or not e.storage_key:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Export is {e.status}")
    audit(db, user_id=user.id, project_id=e.project_id, action="export.download", entity_type="export",
          entity_id=e.id, request=request)
    db.commit()
    return Response(get_storage().get(e.storage_key), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="export-{e.id}-{e.format}.zip"'})
