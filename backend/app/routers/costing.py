from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from ..cache import cached
from ..dates import DateRange, date_range
from ..services import costing

router = APIRouter(prefix="/api/costing", tags=["costing"])


def _stamp(payload: dict[str, Any], was_cached: bool) -> dict[str, Any]:
    return {**payload, "cached": was_cached}


@router.get("/kpis")
async def costing_kpis(rng: DateRange = Depends(date_range), refresh: bool = False):
    """Raw material purchased, material consumed in production, finished goods produced, material cost
    as a share of net sales, and raw-material stock on hand, with deltas vs the previous same-length window."""
    value, hit = await cached(f"costing:kpis:{rng.key()}", lambda: costing.kpis(rng, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/trend")
async def costing_trend(rng: DateRange = Depends(date_range), refresh: bool = False):
    """Per day (or per month over long ranges): raw material purchased, material consumed and finished goods produced."""
    value, hit = await cached(f"costing:trend:{rng.key()}", lambda: costing.trend(rng, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/consumption")
async def costing_consumption(rng: DateRange = Depends(date_range), limit: int = Query(default=15, ge=1, le=100), refresh: bool = False):
    """Material consumed in production (Repack entries): by department, by item group, top items with the change
    vs the previous window, plus the finished goods those entries produced."""
    value, hit = await cached(f"costing:consumption:{rng.key()}:{limit}", lambda: costing.consumption(rng, limit, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/purchases")
async def costing_purchases(rng: DateRange = Depends(date_range), limit: int = Query(default=15, ge=1, le=100), refresh: bool = False):
    """Purchase invoices in the range: by supplier, by item group, and the top raw materials with average,
    last-paid and previous-window rates (price watch)."""
    value, hit = await cached(f"costing:purchases:{rng.key()}:{limit}", lambda: costing.purchases(rng, limit, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/stock")
async def costing_stock(
    rng: DateRange = Depends(date_range), limit: int = Query(default=20, ge=1, le=200),
    group: str = Query(default="Raw Material", description="item group to list"), refresh: bool = False,
):
    """Stock on hand right now (Bin) for one item group, with days of cover at this range's average daily usage."""
    value, hit = await cached(f"costing:stock:{rng.key()}:{limit}:{group}", lambda: costing.stock(rng, limit, group, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)
