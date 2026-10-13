from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import audit, current_user, require_role
from app.models import AuditLog, Export, File, Membership, Project, User
from app.schemas import MemberIn, MemberOut, ProjectIn, ProjectOut

router = APIRouter(prefix="/projects", tags=["projects"])


def _out(p: Project, role: str) -> ProjectOut:
    out = ProjectOut.model_validate(p)
    out.role = role
    return out


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(body: ProjectIn, request: Request, user: User = Depends(current_user),
                   db: Session = Depends(get_db)):
    p = Project(name=body.name, description=body.description, research_question=body.research_question,
                created_by=user.id)
    db.add(p)
    db.flush()
    db.add(Membership(project_id=p.id, user_id=user.id, role="owner"))
    audit(db, user_id=user.id, project_id=p.id, action="project.create", entity_type="project", entity_id=p.id,
          details=body.model_dump(), request=request)
    db.commit()
    return _out(p, "owner")


@router.get("", response_model=list[ProjectOut])
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(
        select(Project, Membership.role).join(Membership, Membership.project_id == Project.id)
        .where(Membership.user_id == user.id).order_by(Project.created_at.desc())
    ).all()
    return [_out(p, role) for p, role in rows]


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    m = require_role(db, user, project_id, "viewer")
    return _out(db.get(Project, project_id), m.role)


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(project_id: str, body: ProjectIn, request: Request, user: User = Depends(current_user),
                   db: Session = Depends(get_db)):
    m = require_role(db, user, project_id, "admin")
    p = db.get(Project, project_id)
    before = {"name": p.name, "description": p.description, "research_question": p.research_question}
    p.name, p.description, p.research_question = body.name, body.description, body.research_question
    audit(db, user_id=user.id, project_id=p.id, action="project.update", entity_type="project", entity_id=p.id,
          details={"before": before, "after": body.model_dump()}, request=request)
    db.commit()
    return _out(p, m.role)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str, request: Request, user: User = Depends(current_user),
                   db: Session = Depends(get_db)):
    """Owner-only hard delete: removes stored PDFs and exports, then all project rows (cascade).
    The audit entry is kept (audit_logs has no FK to projects)."""
    from app.services.storage import get_storage

    require_role(db, user, project_id, "owner")
    store = get_storage()
    keys = [f.storage_key for f in db.scalars(select(File).where(File.project_id == project_id))]
    keys += [e.storage_key for e in db.scalars(select(Export).where(Export.project_id == project_id)) if e.storage_key]
    for k in keys:
        store.delete(k)
    audit(db, user_id=user.id, project_id=project_id, action="project.delete", entity_type="project",
          entity_id=project_id, details={"deleted_objects": len(keys)}, request=request)
    db.delete(db.get(Project, project_id))
    db.commit()


@router.get("/{project_id}/members", response_model=list[MemberOut])
def list_members(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, user, project_id, "viewer")
    rows = db.execute(select(Membership, User).join(User).where(Membership.project_id == project_id)).all()
    return [MemberOut(user_id=u.id, email=u.email, display_name=u.display_name, role=m.role) for m, u in rows]


@router.put("/{project_id}/members", response_model=MemberOut)
def upsert_member(project_id: str, body: MemberIn, request: Request, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    me = require_role(db, user, project_id, "admin")
    if body.role == "owner" and me.role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only owners can grant owner")
    target = db.scalar(select(User).where(func.lower(User.email) == body.email.lower()))
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    m = db.scalar(select(Membership).where(Membership.project_id == project_id, Membership.user_id == target.id))
    if m and m.role == "owner" and me.role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only owners can change an owner")
    if m and m.role == "owner" and body.role != "owner":
        owners = db.scalar(select(func.count()).select_from(Membership).where(
            Membership.project_id == project_id, Membership.role == "owner"))
        if owners <= 1:
            raise HTTPException(status.HTTP_409_CONFLICT, "A project needs at least one owner")
    old = m.role if m else None
    if m is None:
        m = Membership(project_id=project_id, user_id=target.id, role=body.role)
        db.add(m)
    else:
        m.role = body.role
    audit(db, user_id=user.id, project_id=project_id, action="member.upsert", entity_type="membership",
          entity_id=target.id, details={"email": target.email, "old_role": old, "new_role": body.role},
          request=request)
    db.commit()
    return MemberOut(user_id=target.id, email=target.email, display_name=target.display_name, role=m.role)


@router.get("/{project_id}/audit")
def project_audit(project_id: str, limit: int = 200, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    require_role(db, user, project_id, "admin")
    rows = db.scalars(select(AuditLog).where(AuditLog.project_id == project_id)
                      .order_by(AuditLog.created_at.desc()).limit(min(limit, 1000)))
    return [{"id": a.id, "user_id": a.user_id, "action": a.action, "entity_type": a.entity_type,
             "entity_id": a.entity_id, "details": a.details, "created_at": a.created_at} for a in rows]

