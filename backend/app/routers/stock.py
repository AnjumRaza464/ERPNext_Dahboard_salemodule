from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ..cache import cached
from ..dates import DateRange, date_range
from ..services import purchase_analysis, stock

router = APIRouter(prefix="/api/stock", tags=["stock"])


@router.get("/tracking")
async def stock_tracking(rng: DateRange = Depends(date_range), refresh: bool = False):
    """Stock tracking for the range: opening, in, out, closing and current balance per item x warehouse (with days of
    cover, last movement and a low / out / idle status), rolled up per warehouse, item group and movement kind,
    day by day, plus every stock ledger line posted in the range."""
    value, hit = await cached(f"stock:tracking:{rng.key()}", lambda: stock.tracking(rng, refresh=refresh), refresh=refresh)
    return {**value, "cached": hit}


@router.get("/purchases")
async def stock_purchases(
    rng: DateRange = Depends(date_range), refresh: bool = False,
    weekdays: str | None = Query(default=None, description="comma-separated weekday names to keep, e.g. Mon,Sat; empty = all"),
):
    """Purchase analysis for the range: totals vs the previous window, supplier-wise, day-by-day (or month) with the
    per-supplier split, weekday pattern, item-wise with rate watch, supplier x item pairs, every purchase invoice and
    every invoice line (which supplier delivered which item on which day, at what rate)."""
    value, hit = await cached(f"stock:purchases:{rng.key()}:{weekdays or ''}", lambda: purchase_analysis.purchases(rng, refresh=refresh, weekdays=weekdays), refresh=refresh)
    return {**value, "cached": hit}
