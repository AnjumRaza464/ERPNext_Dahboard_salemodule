from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ..cache import cached
from ..dates import DateRange, date_range
from ..services import decline

router = APIRouter(prefix="/api/decline", tags=["decline"])


@router.get("/factors")
async def decline_factors(rng: DateRange = Depends(date_range), limit: int = Query(default=12, ge=1, le=100), refresh: bool = False):
    """Why sales moved against the previous window: traffic, basket, trading days, stock-outs, declining items,
    discounts and returns, each with an estimated PKR impact, ranked; plus the same range vs last week and last month."""
    value, hit = await cached(f"decline:factors:{rng.key()}:{limit}", lambda: decline.factors(rng, limit, refresh=refresh), refresh=refresh)
    return {**value, "cached": hit}


@router.get("/cost-factors")
async def decline_cost_factors(rng: DateRange = Depends(date_range), limit: int = Query(default=12, ge=1, le=100), refresh: bool = False):
    """Why material cost % of sales moved against the previous window: rate rises per material, material per unit of
    output, the sales side, unsold produce, write-offs and plain volume, each with an estimated PKR and percentage-point impact."""
    value, hit = await cached(f"decline:cost:{rng.key()}:{limit}", lambda: decline.cost_factors(rng, limit, refresh=refresh), refresh=refresh)
    return {**value, "cached": hit}
