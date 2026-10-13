from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.connectors import registry
from app.db import get_db
from app.deps import current_user
from app.models import User

router = APIRouter(prefix="/connectors", tags=["connectors"])


@router.get("/status")
def connectors_status(_: User = Depends(current_user), db: Session = Depends(get_db)):
    return registry.status_report(db)
