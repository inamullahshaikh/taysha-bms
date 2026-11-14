"""Projects, tasks (subtasks, checklists, comments) and deadlines."""

from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Text, event, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.audit import audit
from app.auth.access import require_access
from app.auth.deps import CurrentUser
from app.auth.models import User
from app.clock import local_today, utcnow
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB, Base, Entity

Priority = Literal["low", "medium", "high", "urgent"]
Status = Literal["todo", "in_progress", "blocked", "done", "cancelled"]


class Project(Entity, Base):
    __tablename__ = "projects"
    name: Mapped[str] = mapped_column(String(150))
    kind: Mapped[str] = mapped_column(String(30), default="operations")
    status: Mapped[str] = mapped_column(String(20), default="planned")  # planned|active|on_hold|done|cancelled
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    start_date: Mapped[date | None] = mapped_column(Date)
    due_date: Mapped[date | None] = mapped_column(Date)
    description: Mapped[str | None] = mapped_column(Text)


class Task(Entity, Base):
    __tablename__ = "tasks"
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), index=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id"), index=True)  # subtasks
    priority: Mapped[str] = mapped_column(String(10), default="medium")
    status: Mapped[str] = mapped_column(String(20), default="todo", index=True)
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"))
    due_date: Mapped[date | None] = mapped_column(Date, index=True)
    checklist: Mapped[list] = mapped_column(JSONB, default=list)  # [{"text", "done"}]
    blocked_reason: Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    position: Mapped[int] = mapped_column(Integer, default=0)
    related_type: Mapped[str | None] = mapped_column(String(50))  # e.g. orders, purchase_orders
    related_id: Mapped[int | None] = mapped_column()


class TaskComment(Entity, Base):
    __tablename__ = "task_comments"
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    body: Mapped[str] = mapped_column(Text)


@event.listens_for(Task.status, "set")
def _completed(target, value, old, _):
    if value == "done" and old != "done":
        target.completed_at = utcnow()
    elif value != "done":
        target.completed_at = None


@event.listens_for(Task, "before_insert")
def _inherit_project(mapper, connection, target):
    """Subtasks belong to their parent's project."""
    if target.parent_id and target.project_id is None:
        target.project_id = connection.scalar(select(Task.project_id).where(Task.id == target.parent_id))


class ProjectIn(BaseModel):
    name: str = Field(min_length=1)
    kind: Literal["launch", "campaign", "event", "product_development", "operations", "other"] = "operations"
    status: Literal["planned", "active", "on_hold", "done", "cancelled"] = "planned"
    owner_id: int | None = None
    start_date: date | None = None
    due_date: date | None = None
    description: str | None = None


class ProjectPatch(ProjectIn):
    name: str | None = None
    kind: Literal["launch", "campaign", "event", "product_development", "operations", "other"] | None = None
    status: Literal["planned", "active", "on_hold", "done", "cancelled"] | None = None


class ProjectOut(RecordOut, ProjectIn):
    created_at: datetime


class CheckItem(BaseModel):
    text: str
    done: bool = False


class TaskIn(BaseModel):
    title: str = Field(min_length=1)
    description: str | None = None
    project_id: int | None = None
    parent_id: int | None = None
    priority: Priority = "medium"
    status: Status = "todo"
    assignee_id: int | None = None
    department_id: int | None = None
    due_date: date | None = None
    checklist: list[CheckItem] = []
    blocked_reason: str | None = None
    position: int = 0
    related_type: str | None = None
    related_id: int | None = None


class TaskPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    project_id: int | None = None
    priority: Priority | None = None
    status: Status | None = None
    assignee_id: int | None = None
    department_id: int | None = None
    due_date: date | None = None
    checklist: list[CheckItem] | None = None
    blocked_reason: str | None = None
    position: int | None = None


class TaskOut(RecordOut, TaskIn):
    completed_at: datetime | None
    created_by_id: int | None
    created_at: datetime


class CommentIn(BaseModel):
    body: str = Field(min_length=1)


router = APIRouter(tags=["tasks"])
VIEW, CREATE = require_access("tasks", "view"), require_access("tasks", "create")


@router.get("/tasks/mine", response_model=list[TaskOut])
def my_tasks(user: CurrentUser, db: DB, include_done: bool = False):
    q = select(Task).where(Task.assignee_id == user.id, Task.archived_at.is_(None)).order_by(
        Task.due_date.asc().nulls_last(), Task.position)
    if not include_done:
        q = q.where(Task.status.not_in(("done", "cancelled")))
    return db.scalars(q).all()


@router.get("/tasks/overview")
def overview(db: DB, project_id: int | None = None, _: User = VIEW):
    t = local_today()
    base = select(Task).where(Task.archived_at.is_(None))
    if project_id:
        base = base.where(Task.project_id == project_id)
    sub = base.subquery()
    counts = dict(db.execute(select(sub.c.status, func.count()).group_by(sub.c.status)).all())
    open_ = ~sub.c.status.in_(("done", "cancelled"))
    return {"by_status": counts,
            "overdue": db.scalar(select(func.count()).where(open_, sub.c.due_date < t)),
            "due_next_7_days": db.scalar(select(func.count()).where(open_, sub.c.due_date.between(
                t, t + timedelta(days=7)))),
            "blocked": counts.get("blocked", 0)}


@router.get("/tasks/{task_id}/comments")
def comments(task_id: int, db: DB, _: User = VIEW):
    return [{"id": c.id, "body": c.body, "created_by_id": c.created_by_id, "created_at": c.created_at}
            for c in db.scalars(select(TaskComment).where(TaskComment.task_id == task_id).order_by(TaskComment.id))]


@router.post("/tasks/{task_id}/comments", status_code=201)
def add_comment(task_id: int, body: CommentIn, db: DB, _: User = CREATE):
    get_or_404(db, Task, task_id, "Task")
    c = TaskComment(task_id=task_id, body=body.body)
    db.add(c)
    audit(db, "comment", entity_type="tasks", entity_id=task_id)
    db.flush()
    return {"id": c.id}


def overdue_tasks(db: Session):
    return db.scalars(select(Task).where(Task.status.not_in(("done", "cancelled")), Task.due_date < local_today(),
                                         Task.assignee_id.is_not(None), Task.archived_at.is_(None))).all()


class TaskCreate(TaskIn):
    def model_dump(self, **kw):
        return super().model_dump(mode="json", **kw)


class TaskUpdate(TaskPatch):
    def model_dump(self, **kw):
        d = super().model_dump(**kw)
        if d.get("checklist") is not None:
            d["checklist"] = [dict(i) for i in d["checklist"]]
        return d


crud_routers = [
    crud_router(Project, prefix="/projects", feature="tasks", create=ProjectIn, update=ProjectPatch,
                out=ProjectOut, search=(Project.name,), filters={"status": Project.status, "kind": Project.kind,
                                                                 "owner_id": Project.owner_id},
                default_sort=Project.due_date.asc().nulls_last(), tags=["tasks"]),
    crud_router(Task, prefix="/tasks", feature="tasks", create=TaskCreate, update=TaskUpdate, out=TaskOut,
                search=(Task.title, Task.description),
                sorts={"due_date": Task.due_date, "priority": Task.priority, "position": Task.position},
                filters={"status": Task.status, "project_id": Task.project_id, "assignee_id": Task.assignee_id,
                         "parent_id": Task.parent_id, "priority": Task.priority,
                         "department_id": Task.department_id},
                default_sort=Task.due_date.asc().nulls_last(), tags=["tasks"]),
]
routers = [router, *crud_routers]
