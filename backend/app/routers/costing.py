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
async def costing_consumption(rng: DateRange = Depends(date_range), limit: int = Query(default=15, ge=0, le=1000, description="0 = every row"), refresh: bool = False):
    """Material consumed in production (Repack entries): by department, by item group, top items with the change
    vs the previous window, plus the finished goods those entries produced."""
    value, hit = await cached(f"costing:consumption:{rng.key()}:{limit}", lambda: costing.consumption(rng, limit, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/purchases")
async def costing_purchases(rng: DateRange = Depends(date_range), limit: int = Query(default=15, ge=0, le=1000, description="0 = every row"), refresh: bool = False):
    """Purchase invoices in the range: by supplier, by item group, and the top raw materials with average,
    last-paid and previous-window rates (price watch)."""
    value, hit = await cached(f"costing:purchases:{rng.key()}:{limit}", lambda: costing.purchases(rng, limit, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/stock")
async def costing_stock(
    rng: DateRange = Depends(date_range), limit: int = Query(default=20, ge=0, le=1000, description="0 = every row"),
    group: str = Query(default="Raw Material", description="item group to list"), refresh: bool = False,
):
    """Stock on hand right now (Bin) for one item group, with days of cover at this range's average daily usage."""
    value, hit = await cached(f"costing:stock:{rng.key()}:{limit}:{group}", lambda: costing.stock(rng, limit, group, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/departments")
async def costing_departments(
    rng: DateRange = Depends(date_range), limit: int = Query(default=10, ge=0, le=1000, description="0 = every item"), refresh: bool = False,
    weekdays: str | None = Query(default=None, description="comma-separated weekday names to keep, e.g. Mon,Sat; empty = all"),
):
    """Department-wise consumption in detail: summary vs the previous window, day-by-day matrix, weekday averages,
    top items per department and every production entry with what it used and produced."""
    value, hit = await cached(f"costing:departments:{rng.key()}:{limit}:{weekdays or ''}", lambda: costing.departments(rng, limit, refresh=refresh, weekdays=weekdays), refresh=refresh)
    return _stamp(value, hit)


@router.get("/production")
async def costing_production(
    rng: DateRange = Depends(date_range), limit: int = Query(default=15, ge=0, le=1000, description="0 = every item"), refresh: bool = False,
    weekdays: str | None = Query(default=None, description="comma-separated weekday names to keep, e.g. Mon,Sat; empty = all"),
):
    """Finished goods produced in detail: per producing department vs the previous window, day-by-day matrix,
    weekday averages, top products (overall and per department) and every production entry."""
    value, hit = await cached(f"costing:production:{rng.key()}:{limit}:{weekdays or ''}", lambda: costing.production(rng, limit, refresh=refresh, weekdays=weekdays), refresh=refresh)
    return _stamp(value, hit)


@router.get("/flow")
async def costing_flow(
    rng: DateRange = Depends(date_range), refresh: bool = False,
    weekdays: str | None = Query(default=None, description="comma-separated weekday names to keep, e.g. Mon,Sat; empty = all"),
):
    """Purchases, consumption and output in detail: per-metric summary vs the previous window, day-by-day table
    with running totals, weekday averages, and every purchase invoice in the range."""
    value, hit = await cached(f"costing:flow:{rng.key()}:{weekdays or ''}", lambda: costing.flow(rng, refresh=refresh, weekdays=weekdays), refresh=refresh)
    return _stamp(value, hit)


@router.get("/store-issues")
async def costing_store_issues(
    rng: DateRange = Depends(date_range), limit: int = Query(default=0, ge=0, le=1000, description="items per destination; 0 = every item"),
    refresh: bool = False,
    weekdays: str | None = Query(default=None, description="comma-separated weekday names to keep, e.g. Mon,Sat; empty = all"),
):
    """What Stores issued on Material Transfer entries: per destination vs the previous window, against what each
    department consumed and still holds; day-by-day matrix, every item per destination and every transfer entry."""
    value, hit = await cached(f"costing:store-issues:{rng.key()}:{limit}:{weekdays or ''}", lambda: costing.store_issues(rng, limit, refresh=refresh, weekdays=weekdays), refresh=refresh)
    return _stamp(value, hit)


@router.get("/produced-vs-sold")
async def costing_produced_vs_sold(rng: DateRange = Depends(date_range), limit: int = Query(default=0, ge=0, le=1000, description="0 = every product"), refresh: bool = False):
    """Per product: quantity produced plus bought in, against quantity sold on bills in the same range."""
    value, hit = await cached(f"costing:pvs:{rng.key()}:{limit}", lambda: costing.produced_vs_sold(rng, limit, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/adjustments")
async def costing_adjustments(rng: DateRange = Depends(date_range), refresh: bool = False):
    """Stock Reconciliation postings in the range: value added or written off per item and warehouse."""
    value, hit = await cached(f"costing:adjustments:{rng.key()}", lambda: costing.adjustments(rng, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)
