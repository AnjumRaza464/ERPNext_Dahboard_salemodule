from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Query

from ..cache import cached
from ..services import forecast

router = APIRouter(prefix="/api/forecast", tags=["forecast"])


@router.get("/next-day")
async def forecast_next_day(
    date: date | None = Query(default=None, description="the day to plan for; default = tomorrow (Asia/Karachi)"),
    weeks: int = Query(default=4, ge=1, le=12, description="how many past same-weekdays to average"),
    source: str = Query(default="sales", pattern="^(sales|production)$", description="sales = what sold on those days; production = what was produced"),
    refresh: bool = False,
):
    """Production plan for one day: the average of what sold on the same weekday over the last N weeks, per product."""
    value, hit = await cached(f"forecast:next:{date.isoformat() if date else 'tomorrow'}:{weeks}:{source}", lambda: forecast.next_day_plan(date, weeks, refresh=refresh, source=source), refresh=refresh)
    return {**value, "cached": hit}
