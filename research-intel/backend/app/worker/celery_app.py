from celery import Celery

from app.config import get_settings

s = get_settings()
celery = Celery("rip", broker=s.redis_url, backend=None, include=["app.worker.tasks"])
celery.conf.update(
    task_acks_late=True,  # a task is re-delivered if the worker dies mid-run
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_always_eager=s.celery_eager,
    task_eager_propagates=False,
    broker_connection_retry_on_startup=True,
    task_default_queue="rip",
)
