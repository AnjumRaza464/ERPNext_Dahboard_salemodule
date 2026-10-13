from __future__ import annotations

from fastapi import APIRouter, Depends

from ..cache import cached
from ..dates import DateRange, date_range
from ..services import stock

router = APIRouter(prefix="/api/stock", tags=["stock"])


@router.get("/tracking")
async def stock_tracking(rng: DateRange = Depends(date_range), refresh: bool = False):
    """Stock tracking for the range: opening, in, out, closing and current balance per item x warehouse (with days of
    cover, last movement and a low / out / idle status), rolled up per warehouse, item group and movement kind,
    day by day, plus every stock ledger line posted in the range."""
    value, hit = await cached(f"stock:tracking:{rng.key()}", lambda: stock.tracking(rng, refresh=refresh), refresh=refresh)
    return {**value, "cached": hit}
