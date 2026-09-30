from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query

from ..cache import cached
from ..dates import DateRange, date_range, today_local
from ..services import live, sales

router = APIRouter(prefix="/api/sales", tags=["sales"])

MODE_PATTERN = "^(previous|last_week|last_year|custom)$"
MODE_DESC = "previous = same-length window before; last_week = same dates a week ago; last_year = same dates a year ago; custom = cmp_start/cmp_end"


def _stamp(payload: dict[str, Any], was_cached: bool) -> dict[str, Any]:
    return {**payload, "cached": was_cached}


def _cmp_key(mode: str, cmp_start: date | None, cmp_end: date | None) -> str:
    return f"{mode}:{cmp_start.isoformat() if cmp_start else ''}:{cmp_end.isoformat() if cmp_end else ''}"


def _live_range(
    start: date | None = Query(default=None, description="YYYY-MM-DD; default = today (Asia/Karachi)"),
    end: date | None = Query(default=None, description="YYYY-MM-DD; default = start (single day)"),
) -> DateRange:
    today = today_local()
    return DateRange(start or today, end or start or today)


@router.get("/live-compare")
async def sales_live_compare(rng: DateRange = Depends(_live_range), refresh: bool = False):
    """Range (default today) vs the period before, vs the same period last week and vs the 4-week
    same-weekday average: net sales, bills (GCS) and average bill, from POS Invoice. Short cache."""
    value, hit = await cached(f"sales:live:{rng.key()}", lambda: live.live_compare(rng), refresh=refresh, live=True)
    return _stamp(value, hit)


@router.get("/kpis")
async def sales_kpis(
    rng: DateRange = Depends(date_range),
    mode: str = Query(default="previous", pattern=MODE_PATTERN, description=MODE_DESC),
    cmp_start: date | None = Query(default=None), cmp_end: date | None = Query(default=None),
    refresh: bool = False,
):
    """Headline figures on bills (POS Invoice): net sales, bills, average bill, qty, plus data-health facts."""
    value, hit = await cached(
        f"sales:kpis:{rng.key()}:{_cmp_key(mode, cmp_start, cmp_end)}",
        lambda: sales.kpis(rng, mode, cmp_start, cmp_end, refresh=refresh), refresh=refresh,
    )
    return _stamp(value, hit)


@router.get("/invoices")
async def sales_invoices(rng: DateRange = Depends(date_range), refresh: bool = False):
    value, hit = await cached(f"sales:invoices:{rng.key()}", lambda: sales.invoices(rng), refresh=refresh)
    return _stamp(value, hit)


@router.get("/trend")
async def sales_trend(rng: DateRange = Depends(date_range), refresh: bool = False):
    value, hit = await cached(f"sales:trend:{rng.key()}", lambda: sales.trend(rng), refresh=refresh)
    return _stamp(value, hit)


@router.get("/top-items")
async def sales_top_items(
    rng: DateRange = Depends(date_range), limit: int = Query(default=10, ge=1, le=50), refresh: bool = False
):
    value, hit = await cached(f"sales:top:{rng.key()}:{limit}", lambda: sales.top_items(rng, limit, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/pmix")
async def sales_pmix(
    rng: DateRange = Depends(date_range),
    mode: str = Query(default="previous", pattern=MODE_PATTERN, description=MODE_DESC),
    cmp_start: date | None = Query(default=None), cmp_end: date | None = Query(default=None),
    refresh: bool = False,
):
    """Product mix: every item sold in the range (qty, value, shares, average price) with the change vs the comparison period."""
    value, hit = await cached(
        f"sales:pmix:{rng.key()}:{_cmp_key(mode, cmp_start, cmp_end)}",
        lambda: sales.pmix(rng, mode, cmp_start, cmp_end, refresh=refresh), refresh=refresh,
    )
    return _stamp(value, hit)


@router.get("/item-velocity")
async def sales_item_velocity(
    weeks: int = Query(default=4, ge=1, le=12), limit: int = Query(default=30, ge=5, le=200),
    end: date | None = Query(default=None, description="last day of the window; default = today"), refresh: bool = False,
):
    """Typical units per trading day per item over the last N weeks (tomorrow's production plan)."""
    end = end or today_local()
    value, hit = await cached(f"sales:velocity:{weeks}:{limit}:{end.isoformat()}", lambda: sales.item_velocity(weeks, limit, end), refresh=refresh)
    return _stamp(value, hit)


@router.get("/by-outlet")
async def sales_by_outlet(rng: DateRange = Depends(date_range), refresh: bool = False):
    value, hit = await cached(f"sales:outlet:{rng.key()}", lambda: sales.by_outlet(rng), refresh=refresh)
    return _stamp(value, hit)


@router.get("/compare")
async def sales_compare(
    rng: DateRange = Depends(date_range),
    mode: str = Query(default="previous", pattern=MODE_PATTERN, description=MODE_DESC),
    cmp_start: date | None = Query(default=None), cmp_end: date | None = Query(default=None),
    refresh: bool = False,
):
    value, hit = await cached(
        f"sales:compare:{rng.key()}:{_cmp_key(mode, cmp_start, cmp_end)}",
        lambda: sales.compare(rng, mode, cmp_start, cmp_end, refresh=refresh), refresh=refresh,
    )
    return _stamp(value, hit)


@router.get("/compare-breakdown")
async def sales_compare_breakdown(
    rng: DateRange = Depends(date_range),
    mode: str = Query(default="previous", pattern=MODE_PATTERN),
    cmp_start: date | None = Query(default=None), cmp_end: date | None = Query(default=None),
    limit: int = Query(default=10, ge=1, le=50), refresh: bool = False,
):
    value, hit = await cached(
        f"sales:compare-breakdown:{rng.key()}:{_cmp_key(mode, cmp_start, cmp_end)}:{limit}",
        lambda: sales.compare_breakdown(rng, mode, cmp_start, cmp_end, limit, refresh=refresh), refresh=refresh,
    )
    return _stamp(value, hit)


@router.get("/monthly")
async def sales_monthly(rng: DateRange = Depends(date_range), months: int = Query(default=12, ge=3, le=36), refresh: bool = False):
    value, hit = await cached(f"sales:monthly:{rng.end.isoformat()}:{months}", lambda: sales.monthly(rng, months, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/weekly")
async def sales_weekly(
    week_start: date | None = Query(default=None, description="any day of the week to show; default = this week (Asia/Karachi)"),
    refresh: bool = False,
):
    """This week day by day vs last week vs the 4-week same-weekday average (bills from POS Invoice)."""
    ws = week_start or today_local()
    value, hit = await cached(f"sales:weekly:{ws.isoformat()}", lambda: sales.weekly(ws, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/heatmap")
async def sales_heatmap(rng: DateRange = Depends(date_range), refresh: bool = False):
    value, hit = await cached(f"sales:heatmap:{rng.key()}", lambda: sales.heatmap(rng), refresh=refresh)
    return _stamp(value, hit)


@router.get("/item-pareto")
async def sales_item_pareto(rng: DateRange = Depends(date_range), limit: int = Query(default=30, ge=5, le=100), refresh: bool = False):
    value, hit = await cached(f"sales:pareto:{rng.key()}:{limit}", lambda: sales.item_pareto(rng, limit), refresh=refresh)
    return _stamp(value, hit)


@router.get("/run-rate")
async def sales_run_rate(
    rng: DateRange = Depends(date_range),
    target: float | None = Query(default=None, ge=0, description="monthly net-sales target set in the browser; overrides MONTHLY_TARGETS"),
    refresh: bool = False,
):
    value, hit = await cached(f"sales:runrate:{rng.key()}:{target or ''}", lambda: sales.run_rate(rng, target, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/by-item-group")
async def sales_by_item_group(rng: DateRange = Depends(date_range), refresh: bool = False):
    value, hit = await cached(f"sales:itemgroup:{rng.key()}", lambda: sales.by_item_group(rng, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/by-hour")
async def sales_by_hour(rng: DateRange = Depends(date_range), refresh: bool = False):
    value, hit = await cached(f"sales:hour:{rng.key()}", lambda: sales.by_hour(rng, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/by-weekday")
async def sales_by_weekday(rng: DateRange = Depends(date_range), refresh: bool = False):
    value, hit = await cached(f"sales:weekday:{rng.key()}", lambda: sales.by_weekday(rng, refresh=refresh), refresh=refresh)
    return _stamp(value, hit)


@router.get("/invoice-distribution")
async def sales_invoice_distribution(rng: DateRange = Depends(date_range), refresh: bool = False):
    value, hit = await cached(f"sales:dist:{rng.key()}", lambda: sales.invoice_distribution(rng), refresh=refresh)
    return _stamp(value, hit)


@router.get("/top-customers")
async def sales_top_customers(
    rng: DateRange = Depends(date_range), limit: int = Query(default=10, ge=1, le=50), refresh: bool = False
):
    value, hit = await cached(f"sales:customers:{rng.key()}:{limit}", lambda: sales.top_customers(rng, limit), refresh=refresh)
    return _stamp(value, hit)


@router.get("/payment-modes")
async def sales_payment_modes(rng: DateRange = Depends(date_range), refresh: bool = False):
    value, hit = await cached(f"sales:paymodes:{rng.key()}", lambda: sales.payment_modes(rng), refresh=refresh)
    return _stamp(value, hit)


@router.get("/composition")
async def sales_composition(rng: DateRange = Depends(date_range), refresh: bool = False):
    value, hit = await cached(f"sales:composition:{rng.key()}", lambda: sales.composition(rng), refresh=refresh)
    return _stamp(value, hit)


@router.get("/brief")
async def sales_brief(
    date_: date | None = Query(default=None, alias="date", description="day to summarise; default = last trading day"),
    target: float | None = Query(default=None, ge=0), refresh: bool = False,
):
    """Roman Urdu morning brief: last trading day, month pace vs target, this week, tomorrow's typical quantities."""
    key = f"sales:brief:{date_.isoformat() if date_ else 'last'}:{target or ''}:{today_local().isoformat()}"
    value, hit = await cached(key, lambda: sales.brief(date_, target), refresh=refresh)
    return _stamp(value, hit)
