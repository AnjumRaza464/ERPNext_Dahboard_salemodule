"""Live comparison board: a day (or range) against the day before and the same day last week.

Figures come from **POS Invoice** rows, one per customer check, so the check count
(GCS) and the average check are real till transactions. Sales Invoices produced by a
POS closing (`is_consolidated = 1`) duplicate those POS Invoices and are skipped;
any other submitted Sales Invoice (`is_consolidated = 0`, e.g. a direct sale) is added
so non-POS sales are not missed. Today's checks show up here as soon as they are
submitted at the till, before the closing entry creates the Sales Invoice.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

from ..dates import DateRange
from ..erpnext_client import get_client

METRICS = ("sales", "gcs", "avg_check", "qty")
PERIODS = ("current", "previous", "last_week")

# The two sources that together hold every check exactly once.
SOURCES: tuple[tuple[str, list[list[Any]]], ...] = (
    ("POS Invoice", []),
    ("Sales Invoice", [["is_consolidated", "=", 0]]),
)
ROW_FIELDS = ["posting_date", "posting_time", "base_grand_total", "total_qty", "is_return"]
DAY_FIELDS = ["posting_date", "is_return", "count(name) as n", "sum(base_grand_total) as total", "sum(total_qty) as qty"]


def _filters(rng: DateRange, extra: list[list[Any]] | None = None) -> list[list[Any]]:
    return [
        ["docstatus", "=", 1],
        ["company", "=", get_client().company],
        ["posting_date", ">=", rng.start.isoformat()],
        ["posting_date", "<=", rng.end.isoformat()],
        *(extra or []),
    ]


def _hour(value: Any) -> int | None:
    """Time string -> hour. Frappe does not zero-pad single-digit hours (9:05:00), so split, not slice."""
    try:
        return int(str(value).split(":")[0])
    except (TypeError, ValueError):
        return None


def _pct(cur: float, prev: float) -> float | None:
    return round((cur - prev) / abs(prev) * 100, 1) if prev else None


def shift(rng: DateRange, days: int) -> DateRange:
    return DateRange(rng.start + timedelta(days=days), rng.end + timedelta(days=days))


async def _rows(rng: DateRange, hourly: bool) -> list[dict[str, Any]]:
    """Normalised rows: {date, hour, n (checks), total (PKR), qty, is_return}.

    Single day -> one row per check (with its hour); longer ranges -> one row per
    posting_date x is_return, aggregated by ERPNext.
    """
    c = get_client()
    if hourly:
        chunks = await asyncio.gather(*[c.get_all(dt, ROW_FIELDS, _filters(rng, extra)) for dt, extra in SOURCES])
        return [
            {
                "date": str(r.get("posting_date")), "hour": _hour(r.get("posting_time")),
                "n": 0 if r.get("is_return") else 1, "total": float(r.get("base_grand_total") or 0),
                "qty": float(r.get("total_qty") or 0), "is_return": int(r.get("is_return") or 0),
            }
            for chunk in chunks for r in chunk
        ]
    chunks = await asyncio.gather(*[
        c.get_list(dt, DAY_FIELDS, _filters(rng, extra), group_by="posting_date, is_return", limit_page_length=None)
        for dt, extra in SOURCES
    ])
    return [
        {
            "date": str(r.get("posting_date")), "hour": None,
            "n": 0 if r.get("is_return") else int(r.get("n") or 0), "total": float(r.get("total") or 0),
            "qty": float(r.get("qty") or 0), "is_return": int(r.get("is_return") or 0),
        }
        for chunk in chunks for r in chunk
    ]


def _totals(rows: list[dict[str, Any]]) -> dict[str, float | int]:
    sales_rows = [r for r in rows if not r["is_return"]]
    return_rows = [r for r in rows if r["is_return"]]
    gcs = sum(r["n"] for r in sales_rows)
    gross = sum(r["total"] for r in sales_rows)
    ret_total = sum(r["total"] for r in return_rows)  # negative in ERPNext
    net = gross + ret_total
    return {
        "sales": round(net, 2),
        "gross_sales": round(gross, 2),
        "returns_total": round(ret_total, 2),
        "gcs": int(gcs),
        "return_count": len(return_rows),
        "avg_check": round(net / gcs, 2) if gcs else 0.0,
        "qty": round(sum(r["qty"] for r in sales_rows), 3),
    }


def _buckets(rows: list[dict[str, Any]], rng: DateRange, hourly: bool) -> dict[int, dict[str, float]]:
    """Net sales and checks per hour (single day) or per day index within the range."""
    out: dict[int, dict[str, float]] = defaultdict(lambda: {"sales": 0.0, "gcs": 0})
    for r in rows:
        if hourly:
            key = r["hour"]
            if key is None:
                continue
        else:
            try:
                key = (date.fromisoformat(r["date"]) - rng.start).days
            except ValueError:
                continue
        out[key]["sales"] += r["total"]
        out[key]["gcs"] += r["n"]
    return out


def _cumulative(
    buckets: dict[str, dict[int, dict[str, float]]], keys: list[int], ranges: dict[str, DateRange], hourly: bool
) -> list[dict[str, Any]]:
    """Running totals per period, aligned by hour / day index; a series stops (null) after its last activity."""
    last_key = {p: (max(b) if b else None) for p, b in buckets.items()}
    running = {p: {"sales": 0.0, "gcs": 0} for p in PERIODS}
    points = []
    for i, key in enumerate(keys):
        pt: dict[str, Any] = {"index": i + 1, "label": f"{key:02d}:00" if hourly else f"Day {key + 1}", "dates": {}}
        for p in PERIODS:
            b = buckets[p].get(key)
            if b:
                running[p]["sales"] += b["sales"]
                running[p]["gcs"] += b["gcs"]
            active = last_key[p] is not None and key <= last_key[p]
            pt[p] = round(running[p]["sales"], 2) if active else None
            pt[f"{p}_gcs"] = int(running[p]["gcs"]) if active else None
            pt["dates"][p] = ranges[p].start.isoformat() if hourly else (ranges[p].start + timedelta(days=key)).isoformat()
        points.append(pt)
    return points


async def _last_trading_day(before: date) -> str | None:
    c = get_client()
    rows = await asyncio.gather(*[
        c.get_list(
            dt, ["max(posting_date) as d"],
            [["docstatus", "=", 1], ["company", "=", c.company], ["posting_date", "<=", before.isoformat()], *extra],
            limit_page_length=1,
        )
        for dt, extra in SOURCES
    ])
    days = [str(r[0]["d"]) for r in rows if r and r[0].get("d")]
    return max(days) if days else None


async def live_compare(rng: DateRange) -> dict[str, Any]:
    """Current range vs the same-length window before it and vs the same window one week earlier."""
    hourly = rng.days == 1
    ranges = {"current": rng, "previous": rng.previous(), "last_week": shift(rng, -7)}
    rows_by_period, last_day = await asyncio.gather(
        asyncio.gather(*[_rows(ranges[p], hourly) for p in PERIODS]),
        _last_trading_day(rng.end),
    )
    rows = dict(zip(PERIODS, rows_by_period))
    totals = {p: _totals(rows[p]) for p in PERIODS}
    buckets = {p: _buckets(rows[p], ranges[p], hourly) for p in PERIODS}

    active_keys = {k for b in buckets.values() for k, v in b.items() if v["sales"] or v["gcs"]}
    if hourly:
        keys = list(range(min(active_keys), max(active_keys) + 1)) if active_keys else []
    else:
        keys = list(range(rng.days))
    points = _cumulative(buckets, keys, ranges, hourly)

    deltas = {
        cmp: {
            m: {"abs": round(totals["current"][m] - totals[cmp][m], 2), "pct": _pct(totals["current"][m], totals[cmp][m])}
            for m in METRICS
        }
        for cmp in ("previous", "last_week")
    }
    return {
        "source": "pos_invoice",
        "range": rng.as_dict(),
        "as_of": datetime.now(timezone.utc).isoformat(),
        "days": rng.days,
        "granularity": "hour" if hourly else "day",
        "periods": {p: {"key": p, "range": ranges[p].as_dict(), "totals": totals[p]} for p in PERIODS},
        "deltas": deltas,
        "points": points,
        "last_trading_day": last_day,
    }
