"""Live comparison board: a day (or range) against the day before, the same day last week
and the average of the same weekday over the previous calendar month (e.g. every Saturday of
September for a Saturday in October).

Figures come from **POS Invoice** rows, one per customer bill, so the bill count
(GCS) and the average bill are real till transactions. Sales Invoices produced by a
POS closing (`is_consolidated = 1`) duplicate those POS Invoices and are skipped;
any other submitted Sales Invoice (`is_consolidated = 0`, e.g. a direct sale) is added
so non-POS sales are not missed. Today's bills show up here as soon as they are
submitted at the till, before the closing entry creates the Sales Invoice.

Note: posting_time is the time the bill was keyed into ERPNext (bills are entered in
batches), not the moment the customer paid, so per-hour curves show entry progress.

**Business date.** Bills are keyed into ERPNext one to several days after the trading
day, so a bill's `posting_date` is the keying day, not the day it was sold. The day the
owner means is the **POS Closing Entry's period end date**: every closed bill takes that
date (`closing_index` / `bills`), and only bills not yet in a submitted closing, plus
non-consolidated Sales Invoices, fall back to their posting date. Every figure on the
Sales tab is dated this way.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

from ..cache import cached
from ..config import get_settings
from ..dates import DateRange, now_local, today_local
from ..erpnext_client import get_client

METRICS = ("sales", "gcs", "avg_check", "qty")
PERIODS = ("current", "previous", "last_week", "weekday_avg")

# The two sources that together hold every bill exactly once.
SOURCES: tuple[tuple[str, list[list[Any]]], ...] = (
    ("POS Invoice", []),
    ("Sales Invoice", [["is_consolidated", "=", 0]]),
)
# Bills that have no closing entry yet, so their only date is the posting date.
OPEN_SOURCES: tuple[tuple[str, list[list[Any]]], ...] = (
    ("POS Invoice", [["status", "!=", "Consolidated"]]),
    ("Sales Invoice", [["is_consolidated", "=", 0]]),
)
ROW_FIELDS = ["posting_date", "posting_time", "base_grand_total", "base_total", "base_discount_amount", "total_qty", "is_return"]
CLOSING_FIELDS = ["name", "period_end_date", "posting_date"]
BILL_CHUNK = 200  # "name in [...]" filters per request (URL length)


def _filters(rng: DateRange | None, extra: list[list[Any]] | None = None, dates: list[date] | None = None) -> list[list[Any]]:
    """Posting-date filters (keying day). Use `bills()` for anything dated by business day."""
    f: list[list[Any]] = [["docstatus", "=", 1], ["company", "=", get_client().company]]
    if dates is not None:
        f.append(["posting_date", "in", [d.isoformat() for d in dates]])
    elif rng is not None:
        f += [["posting_date", ">=", rng.start.isoformat()], ["posting_date", "<=", rng.end.isoformat()]]
    return f + list(extra or [])


def _chunks(names: list[str]) -> list[list[str]]:
    return [names[i:i + BILL_CHUNK] for i in range(0, len(names), BILL_CHUNK)]


# ------------------------------------------------------------------ business date (POS Closing Entry period end)

def _closing_date(r: dict[str, Any]) -> str:
    return str(r.get("period_end_date") or r.get("posting_date"))[:10]


async def closing_index(refresh: bool = False) -> dict[str, Any]:
    """Every submitted POS Closing Entry, as lookups keyed by document name (cached).

    bills    -> {POS Invoice name: business date}  (period end date of its closing)
    invoices -> {consolidated Sales Invoice / credit note name: business date}
    dates    -> sorted business dates that have at least one closed bill
    """

    async def _load() -> dict[str, Any]:
        c = get_client()
        closings, refs, logs = await asyncio.gather(
            c.get_all("POS Closing Entry", CLOSING_FIELDS, [["docstatus", "=", 1], ["company", "=", c.company]]),
            c.get_all("POS Invoice Reference", ["parent", "pos_invoice"],
                      [["parenttype", "=", "POS Closing Entry"], ["docstatus", "=", 1]], parent="POS Closing Entry"),
            c.get_all("POS Invoice Merge Log", ["pos_closing_entry", "consolidated_invoice", "consolidated_credit_note"], [["docstatus", "=", 1]]),
        )
        by_closing = {r["name"]: _closing_date(r) for r in closings}
        bills = {r["pos_invoice"]: by_closing[r["parent"]] for r in refs if r["parent"] in by_closing}
        invoices: dict[str, str] = {}
        for r in logs:
            d = by_closing.get(r.get("pos_closing_entry") or "")
            if not d:
                continue
            for key in ("consolidated_invoice", "consolidated_credit_note"):
                if r.get(key):
                    invoices[r[key]] = d
        return {"bills": bills, "invoices": invoices, "dates": sorted(set(bills.values()))}

    value, _ = await cached("live:closings", _load, refresh=refresh)
    return value


def _in_window(rng: DateRange | None, dates: list[date] | None):
    wanted = {d.isoformat() for d in dates} if dates is not None else None
    lo, hi = (rng.start.isoformat(), rng.end.isoformat()) if rng is not None else ("", "9999")

    def check(d: str) -> bool:
        return d in wanted if wanted is not None else lo <= d <= hi

    return check


async def _fetch_closed(doctype: str, names: list[str], fields: list[str]) -> list[dict[str, Any]]:
    c = get_client()
    base = [["docstatus", "=", 1], ["company", "=", c.company]]
    chunks = await asyncio.gather(*[c.get_list(doctype, fields, base + [["name", "in", chunk]], limit_page_length=None) for chunk in _chunks(names)])
    return [r for chunk in chunks for r in chunk]


async def bills(rng: DateRange | None, fields: list[str], dates: list[date] | None = None, refresh: bool = False) -> list[dict[str, Any]]:
    """Every bill whose business date is in `rng` (or on `dates`), from POS Invoice plus non-consolidated
    Sales Invoice. Each row carries `doctype`, `name`, `posting_date` and `business_date`: the period end
    date of the bill's POS Closing Entry, or the posting date while the bill has no closing yet."""
    idx = await closing_index(refresh)
    inside = _in_window(rng, dates)
    want = list(dict.fromkeys([*fields, "name", "posting_date"]))
    closed = [n for n, d in idx["bills"].items() if inside(d)]
    c = get_client()
    closed_rows, *open_chunks = await asyncio.gather(
        _fetch_closed("POS Invoice", closed, want),
        *[c.get_all(dt, want, _filters(rng, extra, dates)) for dt, extra in OPEN_SOURCES],
    )
    out: list[dict[str, Any]] = []
    for r in closed_rows:
        out.append({**r, "doctype": "POS Invoice", "business_date": idx["bills"][r["name"]]})
    for (dt, _), chunk in zip(OPEN_SOURCES, open_chunks):
        for r in chunk:
            if dt == "POS Invoice" and r["name"] in idx["bills"]:
                continue  # closed between the two queries; already counted above
            out.append({**r, "doctype": dt, "business_date": str(r["posting_date"])})
    return out


async def sales_invoices(rng: DateRange, fields: list[str]) -> list[dict[str, Any]]:
    """Submitted Sales Invoices dated by business day: consolidated ones through their closing entry,
    the rest (direct sales) by posting date. Each row carries `business_date`."""
    idx = await closing_index()
    inside = _in_window(rng, None)
    want = list(dict.fromkeys([*fields, "name", "posting_date"]))
    closed = [n for n, d in idx["invoices"].items() if inside(d)]
    closed_rows, open_rows = await asyncio.gather(
        _fetch_closed("Sales Invoice", closed, want),
        get_client().get_all("Sales Invoice", want, _filters(rng, [["is_consolidated", "=", 0]])),
    )
    out = [{**r, "business_date": idx["invoices"][r["name"]]} for r in closed_rows]
    out += [{**r, "business_date": str(r["posting_date"])} for r in open_rows if r["name"] not in idx["invoices"]]
    return out


def _hour(value: Any) -> int | None:
    """Time string -> hour. Frappe does not zero-pad single-digit hours (9:05:00), so split, not slice."""
    try:
        return int(str(value).split(":")[0])
    except (TypeError, ValueError):
        return None


def fmt_time(value: Any) -> str | None:
    """Frappe times come back like '18:15:6.21128'; normalise to HH:MM:SS."""
    if value in (None, ""):
        return None
    try:
        parts = str(value).split(".")[0].split(":")
        h, m, s = (int(parts[0]), int(parts[1]) if len(parts) > 1 else 0, int(parts[2]) if len(parts) > 2 else 0)
        return f"{h:02d}:{m:02d}:{s:02d}"
    except (TypeError, ValueError):
        return str(value)[:8]


def _pct(cur: float, prev: float) -> float | None:
    return round((cur - prev) / abs(prev) * 100, 1) if prev else None


def shift(rng: DateRange, days: int) -> DateRange:
    return rng.shift(days)


def _norm_row(r: dict[str, Any], hourly: bool) -> dict[str, Any]:
    return {
        "date": r["business_date"],
        "hour": _hour(r.get("posting_time")) if hourly else None,
        "time": fmt_time(r.get("posting_time")) if hourly else None,
        "n": 1,
        "total": float(r.get("base_grand_total") or 0),
        "gross": float(r.get("base_total") or 0),
        "discounts": float(r.get("base_discount_amount") or 0),
        "qty": float(r.get("total_qty") or 0),
        "is_return": int(r.get("is_return") or 0),
    }


async def _rows(rng: DateRange | None, hourly: bool, dates: list[date] | None = None, refresh: bool = False) -> list[dict[str, Any]]:
    """Normalised bill rows for a range (or an explicit list of dates), dated by business day.

    hourly=True  -> one row per bill (with its entry hour and time)
    hourly=False -> one row per business date x is_return
    Keys: date, hour, time, n (bills), total (net PKR incl. returns), gross, discounts, qty, is_return.
    """
    rows = [_norm_row(r, hourly) for r in await bills(rng, ROW_FIELDS, dates, refresh)]
    if hourly:
        return rows
    agg: dict[tuple[str, int], dict[str, Any]] = {}
    for r in rows:
        a = agg.setdefault((r["date"], r["is_return"]), {**r, "n": 0, "total": 0.0, "gross": 0.0, "discounts": 0.0, "qty": 0.0})
        a["n"] += 1
        for k in ("total", "gross", "discounts", "qty"):
            a[k] += r[k]
    return list(agg.values())


def _totals(rows: list[dict[str, Any]]) -> dict[str, float | int]:
    sales_rows = [r for r in rows if not r["is_return"]]
    return_rows = [r for r in rows if r["is_return"]]
    gcs = sum(r["n"] for r in sales_rows)
    gross_grand = sum(r["total"] for r in sales_rows)
    ret_total = sum(r["total"] for r in return_rows)  # negative in ERPNext
    net = gross_grand + ret_total
    return {
        "sales": round(net, 2),
        "gross_sales": round(gross_grand, 2),
        "returns_total": round(ret_total, 2),
        "discounts": round(sum(r["discounts"] for r in sales_rows), 2),
        "gcs": int(gcs),
        "return_count": int(sum(r["n"] for r in return_rows)),
        "avg_check": round(net / gcs, 2) if gcs else 0.0,
        "qty": round(sum(r["qty"] for r in sales_rows), 3),
        "trading_days": int(len({r["date"] for r in sales_rows if r["n"]})),
    }


def _buckets(rows: list[dict[str, Any]], start: date, hourly: bool) -> dict[int, dict[str, float]]:
    """Net sales and bills per hour (single day) or per day index from `start`."""
    out: dict[int, dict[str, float]] = defaultdict(lambda: {"sales": 0.0, "gcs": 0})
    for r in rows:
        if hourly:
            key = r["hour"]
            if key is None:
                continue
        else:
            try:
                key = (date.fromisoformat(r["date"]) - start).days
            except ValueError:
                continue
        out[key]["sales"] += r["total"]
        out[key]["gcs"] += r["n"] if not r["is_return"] else 0
    return out


def _cumulative_series(buckets: dict[int, dict[str, float]], keys: list[int]) -> dict[int, dict[str, float] | None]:
    """Running total at each key; None after the last key with activity."""
    last = max(buckets) if buckets else None
    out: dict[int, dict[str, float] | None] = {}
    sales = 0.0
    gcs = 0
    for k in keys:
        b = buckets.get(k)
        if b:
            sales += b["sales"]
            gcs += b["gcs"]
        out[k] = {"sales": sales, "gcs": gcs} if (last is not None and k <= last) else None
    return out


async def _last_trading_day(before: date) -> str | None:
    """Latest business date on or before `before` with a bill: the last closing's period end, or a
    later posting date of a bill that has no closing yet."""
    c = get_client()
    idx, *rows = await asyncio.gather(
        closing_index(),
        *[
            c.get_list(
                dt, ["max(posting_date) as d"],
                [["docstatus", "=", 1], ["company", "=", c.company], ["posting_date", "<=", before.isoformat()], *extra],
                limit_page_length=1,
            )
            for dt, extra in OPEN_SOURCES
        ],
    )
    days = [d for d in idx["dates"] if d <= before.isoformat()][-1:]
    days += [str(r[0]["d"]) for r in rows if r and r[0].get("d")]
    return max(days) if days else None


def last_month_weekdays(day: date) -> list[date]:
    """Every date in the calendar month before `day` that falls on the same weekday as `day`
    (four or five of them): the baseline for the weekday average."""
    last = day.replace(day=1) - timedelta(days=1)
    first = last.replace(day=1)
    d = first + timedelta(days=(day.weekday() - first.weekday()) % 7)
    out = []
    while d <= last:
        out.append(d)
        d += timedelta(days=7)
    return out


def default_live_day(last_trading_day: str | None, today: date | None = None) -> date:
    """What the board shows when nobody picked a date: today, or the last trading day
    before 11:00 local (the shop has not opened / nothing keyed in yet)."""
    today = today or today_local()
    if now_local().hour < 11 and last_trading_day:
        try:
            return min(date.fromisoformat(last_trading_day), today)
        except ValueError:
            return today
    return today


async def live_compare(rng: DateRange) -> dict[str, Any]:
    """Current range vs the same-length window before it, vs the same window one week earlier,
    and (single day only) vs the average of the same weekday over the previous calendar month."""
    hourly = rng.days == 1
    today = today_local()
    ranges: dict[str, DateRange | None] = {"current": rng, "previous": rng.previous(), "last_week": rng.shift(-7), "weekday_avg": None}
    excluded = get_settings().live_excluded_dates
    month_days = last_month_weekdays(rng.start) if hourly else []
    baseline_dates = [d for d in month_days if d.isoformat() not in excluded]

    def _period(name: str):
        r = ranges[name]
        assert r is not None
        # today's rows change by the minute; past windows are stable, so they can sit in the normal 2-minute cache
        return _rows(r, hourly) if r.end >= today else _cached_rows(r, hourly)

    cur_rows, prev_rows, lw_rows, base_rows, last_day = await asyncio.gather(
        _period("current"), _period("previous"), _period("last_week"),
        _cached_rows_for_dates(baseline_dates, hourly) if baseline_dates else _empty(),
        _last_trading_day(rng.end),
    )
    rows: dict[str, list[dict[str, Any]]] = {"current": cur_rows, "previous": prev_rows, "last_week": lw_rows}
    totals: dict[str, dict[str, Any]] = {p: _totals(rows[p]) for p in rows}

    # ---- last month's same-weekday baseline: mean over the weeks in which that weekday traded
    base_by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in base_rows:
        base_by_date[r["date"]].append(r)
    trading = [d for d, rs in base_by_date.items() if any(x["n"] and not x["is_return"] for x in rs)]
    trading_weeks = len(trading)
    if trading_weeks:
        per_day = [_totals(base_by_date[d]) for d in trading]
        totals["weekday_avg"] = {
            "sales": round(sum(t["sales"] for t in per_day) / trading_weeks, 2),
            "gross_sales": round(sum(t["gross_sales"] for t in per_day) / trading_weeks, 2),
            "returns_total": round(sum(t["returns_total"] for t in per_day) / trading_weeks, 2),
            "discounts": round(sum(t["discounts"] for t in per_day) / trading_weeks, 2),
            "gcs": round(sum(t["gcs"] for t in per_day) / trading_weeks, 1),
            "return_count": round(sum(t["return_count"] for t in per_day) / trading_weeks, 1),
            "avg_check": round(sum(t["sales"] for t in per_day) / sum(t["gcs"] for t in per_day), 2) if sum(t["gcs"] for t in per_day) else 0.0,
            "qty": round(sum(t["qty"] for t in per_day) / trading_weeks, 3),
            "trading_days": trading_weeks,
        }
    else:
        totals["weekday_avg"] = {**{k: 0 for k in ("sales", "gross_sales", "returns_total", "discounts", "gcs", "return_count", "avg_check", "qty")}, "trading_days": 0}

    # ---- running-total points
    buckets = {p: _buckets(rows[p], ranges[p].start, hourly) for p in rows}  # type: ignore[union-attr]
    base_buckets = {d: _buckets(base_by_date[d], date.fromisoformat(d), hourly) for d in trading}
    active_keys = {k for b in buckets.values() for k, v in b.items() if v["sales"] or v["gcs"]}
    active_keys |= {k for b in base_buckets.values() for k, v in b.items() if v["sales"] or v["gcs"]}
    keys = (list(range(min(active_keys), max(active_keys) + 1)) if active_keys else []) if hourly else list(range(rng.days))
    series = {p: _cumulative_series(buckets[p], keys) for p in rows}
    base_series = [_cumulative_series(b, keys) for b in base_buckets.values()]
    points = []
    for i, key in enumerate(keys):
        pt: dict[str, Any] = {"index": i + 1, "label": f"{key:02d}:00" if hourly else f"Day {key + 1}", "dates": {}}
        for p in rows:
            v = series[p][key]
            pt[p] = round(v["sales"], 2) if v else None
            pt[f"{p}_gcs"] = int(v["gcs"]) if v else None
            r = ranges[p]
            assert r is not None
            pt["dates"][p] = r.start.isoformat() if hourly else (r.start + timedelta(days=key)).isoformat()
        vals = [s[key] for s in base_series]
        live_vals = [v for v in vals if v]
        # a baseline day that has already finished keeps its final total for the rest of the day
        finished = [s for s in base_series if s[key] is None and any(x for x in s.values())]
        finals = [next(x for x in reversed(list(s.values())) if x) for s in finished]
        allv = live_vals + finals
        pt["weekday_avg"] = round(sum(v["sales"] for v in allv) / len(allv), 2) if allv else None
        pt["weekday_avg_gcs"] = round(sum(v["gcs"] for v in allv) / len(allv), 1) if allv else None
        points.append(pt)

    deltas = {}
    for cmp in ("previous", "last_week", "weekday_avg"):
        ok = cmp != "weekday_avg" or trading_weeks >= 2
        deltas[cmp] = {
            m: {"abs": round(totals["current"][m] - totals[cmp][m], 2) if ok else None,
                "pct": _pct(totals["current"][m], totals[cmp][m]) if ok else None}
            for m in METRICS
        }

    # ---- day-close facts for the current day (entry times, not customer times)
    day_close = None
    if hourly:
        bills = [r for r in cur_rows if not r["is_return"] and r["time"]]
        if bills:
            times = sorted(r["time"] for r in bills)
            day_close = {"first_bill": times[0], "last_bill": times[-1]}

    return {
        "source": "pos_invoice",
        "range": rng.as_dict(),
        "as_of": datetime.now(timezone.utc).isoformat(),
        "days": rng.days,
        "granularity": "hour" if hourly else "day",
        "periods": {
            **{p: {"key": p, "range": ranges[p].as_dict(), "totals": totals[p]} for p in rows},  # type: ignore[union-attr]
            "weekday_avg": {
                "key": "weekday_avg", "range": None, "totals": totals["weekday_avg"],
                "weekday": rng.start.strftime("%A") if hourly else None,
                "trading_weeks": trading_weeks, "dates": sorted(trading),
                "month": month_days[0].strftime("%B %Y") if month_days else None,
            },
        },
        "deltas": deltas,
        "points": points,
        "last_trading_day": last_day,
        "day_close": day_close,
        "note": "posting_time is the time bills were keyed into ERPNext, not the customer's time",
    }


async def _empty() -> list[dict[str, Any]]:
    return []


async def _cached_rows(r: DateRange, hourly: bool) -> list[dict[str, Any]]:
    rows, _ = await cached(f"live:rows:{r.key()}:{int(hourly)}", lambda: _rows(r, hourly))
    return rows


async def _cached_rows_for_dates(dates: list[date], hourly: bool) -> list[dict[str, Any]]:
    key = "live:rows:dates:" + ",".join(d.isoformat() for d in dates) + f":{int(hourly)}"
    rows, _ = await cached(key, lambda: _rows(None, hourly, dates=dates))
    return rows
