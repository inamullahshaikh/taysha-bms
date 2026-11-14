"""Research & development: product ideas, trials (recipe / packaging / shelf-life / storage), feedback,
observations, version comparison, and approving a tested recipe into production. Confidential."""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import Date, ForeignKey, Integer, Numeric, String, Text, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.audit import audit
from app.auth.access import can, ensure, require_access
from app.auth.models import User
from app.crud import RecordOut, crud_router, get_or_404
from app.db import DB, Base, Entity
from app.errors import AppError
from app.production.models import Recipe
from app.production.router import activate
from app.production.service import standard_cost

ZERO = Decimal(0)


class RDIdea(Entity, Base):
    __tablename__ = "rd_ideas"
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="idea")  # idea|testing|approved|rejected|launched
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"))
    target_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    target_price: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    notes: Mapped[str | None] = mapped_column(Text)


class RDTrial(Entity, Base):
    __tablename__ = "rd_trials"
    idea_id: Mapped[int] = mapped_column(ForeignKey("rd_ideas.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # recipe | packaging | shelf_life | storage
    recipe_id: Mapped[int | None] = mapped_column(ForeignKey("recipes.id"))
    trial_date: Mapped[date | None] = mapped_column(Date)
    quantity_made: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))
    status: Mapped[str] = mapped_column(String(20), default="planned")  # planned | running | done
    results: Mapped[str | None] = mapped_column(Text)
    rating: Mapped[int | None] = mapped_column(Integer)  # 1..5 overall
    feedback: Mapped[list] = mapped_column(JSONB, default=list)  # [{"who", "rating", "comment"}]
    observations: Mapped[list] = mapped_column(JSONB, default=list)  # [{"day", "note"}]
    packaging_spec: Mapped[str | None] = mapped_column(Text)
    storage_conditions: Mapped[str | None] = mapped_column(String(200))


class IdeaIn(BaseModel):
    title: str = Field(min_length=1)
    description: str | None = None
    status: Literal["idea", "testing", "approved", "rejected", "launched"] = "idea"
    owner_id: int | None = None
    product_id: int | None = None
    target_cost: Decimal | None = Field(None, ge=0)
    target_price: Decimal | None = Field(None, ge=0)
    notes: str | None = None


class IdeaPatch(IdeaIn):
    title: str | None = None
    status: Literal["idea", "testing", "approved", "rejected", "launched"] | None = None


class IdeaOut(RecordOut, IdeaIn):
    created_at: datetime


class TrialIn(BaseModel):
    idea_id: int
    kind: Literal["recipe", "packaging", "shelf_life", "storage"]
    recipe_id: int | None = None
    trial_date: date | None = None
    quantity_made: Decimal | None = Field(None, ge=0)
    status: Literal["planned", "running", "done"] = "planned"
    results: str | None = None
    rating: int | None = Field(None, ge=1, le=5)
    packaging_spec: str | None = None
    storage_conditions: str | None = None


class TrialPatch(BaseModel):
    recipe_id: int | None = None
    trial_date: date | None = None
    quantity_made: Decimal | None = Field(None, ge=0)
    status: Literal["planned", "running", "done"] | None = None
    results: str | None = None
    rating: int | None = Field(None, ge=1, le=5)
    packaging_spec: str | None = None
    storage_conditions: str | None = None


class TrialOut(RecordOut, TrialIn):
    feedback: list
    observations: list


class FeedbackIn(BaseModel):
    who: str = Field(min_length=1)
    rating: int = Field(ge=1, le=5)
    comment: str | None = None


class ObservationIn(BaseModel):
    day: int = Field(ge=0)
    note: str = Field(min_length=1)


router = APIRouter(prefix="/rnd", tags=["r&d"])
VIEW, EDIT = require_access("rnd", "view"), require_access("rnd", "edit")


@router.post("/trials/{trial_id}/feedback", response_model=TrialOut)
def add_feedback(trial_id: int, body: FeedbackIn, db: DB, _: User = EDIT):
    t = get_or_404(db, RDTrial, trial_id, "Trial")
    t.feedback = [*t.feedback, body.model_dump()]
    return t


@router.post("/trials/{trial_id}/observations", response_model=TrialOut)
def add_observation(trial_id: int, body: ObservationIn, db: DB, _: User = EDIT):
    """Shelf-life / storage notes by day since the trial batch was made."""
    t = get_or_404(db, RDTrial, trial_id, "Trial")
    t.observations = sorted([*t.observations, body.model_dump()], key=lambda o: o["day"])
    return t


@router.get("/ideas/{idea_id}/compare")
def compare(idea_id: int, db: DB, user: User = VIEW):
    """Trials side by side: recipe version, cost per unit at today's prices, ratings."""
    get_or_404(db, RDIdea, idea_id, "Idea")
    show_cost = can(db, user, "product_costs", "view")
    rows = []
    for t in db.scalars(select(RDTrial).where(RDTrial.idea_id == idea_id).order_by(RDTrial.id)):
        r = db.get(Recipe, t.recipe_id) if t.recipe_id else None
        ratings = [f["rating"] for f in t.feedback]
        rows.append({"trial_id": t.id, "kind": t.kind, "trial_date": t.trial_date,
                     "recipe_version": r.version if r else None, "recipe_status": r.status if r else None,
                     "cost_per_unit": standard_cost(db, r, r.yield_quantity)["per_unit"] if r and show_cost else None,
                     "rating": t.rating,
                     "avg_feedback": round(Decimal(sum(ratings)) / len(ratings), 1) if ratings else None,
                     "feedback_count": len(ratings), "results": t.results})
    return rows


@router.post("/trials/{trial_id}/approve-recipe")
def approve_recipe(trial_id: int, db: DB, user: User = EDIT):
    """The tested recipe becomes the active production version (needs recipe approval access)."""
    ensure(db, user, "recipes", "approve")
    t = get_or_404(db, RDTrial, trial_id, "Trial")
    if not t.recipe_id:
        raise AppError(422, "no_recipe", "This trial has no recipe")
    out = activate(t.recipe_id, db, user)
    idea = db.get(RDIdea, t.idea_id)
    idea.status = "approved"
    idea.product_id = idea.product_id or out.product_id
    audit(db, "approve", entity_type="rd_trials", entity_id=t.id, note=f"recipe v{out.version} activated")
    return {"recipe_id": out.id, "version": out.version, "status": out.status}


crud_routers = [
    crud_router(RDIdea, prefix="/rnd/ideas", feature="rnd", create=IdeaIn, update=IdeaPatch, out=IdeaOut,
                search=(RDIdea.title, RDIdea.description), filters={"status": RDIdea.status}, tags=["r&d"]),
    crud_router(RDTrial, prefix="/rnd/trials", feature="rnd", create=TrialIn, update=TrialPatch, out=TrialOut,
                filters={"idea_id": RDTrial.idea_id, "kind": RDTrial.kind, "status": RDTrial.status}, tags=["r&d"]),
]
routers = [router, *crud_routers]
