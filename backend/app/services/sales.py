"""Sales figures for the dashboard.

Bills come from POS Invoice (one document per customer bill) plus any Sales Invoice that
was not produced by a POS closing - see services/live.py (`live.SOURCES`). A consolidated
Sales Invoice is one till closing, so it is only used where documents themselves are
listed (invoice table, composition). All counts, averages and per-day statistics are
built on two shared, cached frames:

* `_check_days(rng)`  - one row per posting date (bills, net sales, qty, gross, discounts)
* `_item_frame(rng)`  - one row per item sold (qty, amount, group)

Derived statistics (averages, best/lowest day, baselines) leave out the dates listed in
`EXCLUDE_DATES_FROM_STATS` (opening / bulk stock entries); totals never do.
"""
from __future__ import annotations

import asyncio
import calendar
from datetime import date, timedelta
from typing import Any

import pandas as pd

from ..cache import cached
from ..config import get_settings
from ..dates import DateRange, today_local
from ..erpnext_client import get_client
from . import live
from .live import fmt_time

INVOICE_FIELDS = [
    "name", "posting_date", "posting_time", "customer", "customer_name",
    "base_grand_total", "base_net_total", "total_taxes_and_charges", "discount_amount",
    "outstanding_amount", "status", "is_return", "is_pos", "cost_center",
    "pos_profile", "set_warehouse", "total_qty", "due_date",
]
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
WEEKDAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
DATA_FROM = date(2026, 4, 13)  # Monday of the first week with bills
COMPARE_MODES = ("previous", "last_week", "last_year", "custom")

# Item lines live in a child table per source; parent-in chunks are mandatory (no parent-field filters).
ITEM_SOURCES: tuple[tuple[str, str, list[list[Any]]], ...] = (
    ("POS Invoice", "POS Invoice Item", []),
    ("Sales Invoice", "Sales Invoice Item", [["is_consolidated", "=", 0]]),
)
ITEM_CHUNK = 200
DAY_COLS = ["date", "hour", "time", "n", "total", "gross", "discounts", "qty", "is_return"]


def _base_filters(rng: DateRange) -> list[list[Any]]:
    """Filters for the Sales Invoice doctype (document listings only)."""
    c = get_client()
    return [
        ["docstatus", "=", 1],
        ["company", "=", c.company],
        ["posting_date", ">=", rng.start.isoformat()],
        ["posting_date", "<=", rng.end.isoformat()],
    ]


def outlet_label(cost_center: str | None, pos_profile: str | None = None, warehouse: str | None = None) -> str:
    raw = cost_center or pos_profile or warehouse or "Unassigned"
    label = raw.strip()
    # Strip the trailing " - <ABBR>" company suffix ERPNext appends to account/cost-center names
    if " - " in label:
        head, _, tail = label.rpartition(" - ")
        if tail.isupper() and len(tail) <= 5:
            label = head
    return label.strip() or "Unassigned"


def _pct(cur: float, prev: float) -> float | None:
    return round((cur - prev) / abs(prev) * 100, 1) if prev else None


def _excluded() -> set[str]:
    return get_settings().excluded_dates


def _refresh_ok(rng: DateRange, refresh: bool) -> bool:
    """Only ranges that reach today can change; past windows never need a cache bypass."""
    return refresh and rng.end >= today_local()


# ------------------------------------------------------------------ shared frames

async def _check_days(rng: DateRange, refresh: bool = False) -> pd.DataFrame:
    """Bills aggregated per posting date x is_return, over live.SOURCES (cached)."""
    rows, _ = await cached(f"sales:days:{rng.key()}", lambda: live._rows(rng, hourly=False), refresh=_refresh_ok(rng, refresh))
    df = pd.DataFrame(rows, columns=DAY_COLS)
    for col in ("n", "total", "gross", "discounts", "qty", "is_return"):
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
    return df


async def _check_rows(rng: DateRange, refresh: bool = False) -> pd.DataFrame:
    """One row per bill with its (entry) hour, over live.SOURCES (cached)."""
    rows, _ = await cached(f"sales:rows:{rng.key()}", lambda: live._rows(rng, hourly=True), refresh=_refresh_ok(rng, refresh))
    df = pd.DataFrame(rows, columns=DAY_COLS)
    for col in ("n", "total", "gross", "discounts", "qty", "is_return"):
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
    df["hour"] = pd.to_numeric(df["hour"], errors="coerce")
    return df


def _daily(df: pd.DataFrame, rng: DateRange) -> pd.DataFrame:
    """One row per calendar day in the range: net, gross_sales, checks, qty, returns_total, return_count, discounts, excluded."""
    days = pd.date_range(rng.start, rng.end, freq="D")
    out = pd.DataFrame({"date": days})
    out["excluded"] = out["date"].dt.strftime("%Y-%m-%d").isin(_excluded())
    if df.empty:
        for col in ("net", "gross_sales", "checks", "qty", "returns_total", "return_count", "discounts"):
            out[col] = 0.0
        out["checks"] = out["checks"].astype(int)
        out["return_count"] = out["return_count"].astype(int)
        return out
    d = df.copy()
    d["date"] = pd.to_datetime(d["date"], errors="coerce")
    sales = d[d["is_return"] == 0].groupby("date").agg(gross_sales=("total", "sum"), checks=("n", "sum"), qty=("qty", "sum"), discounts=("discounts", "sum"))
    rets = d[d["is_return"] == 1].groupby("date").agg(returns_total=("total", "sum"), return_count=("n", "sum"))
    out = out.merge(sales, left_on="date", right_index=True, how="left").merge(rets, left_on="date", right_index=True, how="left")
    for col in ("gross_sales", "checks", "qty", "discounts", "returns_total", "return_count"):
        out[col] = out[col].fillna(0)
    out["checks"] = out["checks"].astype(int)
    out["return_count"] = out["return_count"].astype(int)
    out["net"] = out["gross_sales"] + out["returns_total"]
    return out


def _totals_from_days(daily: pd.DataFrame) -> dict[str, Any]:
    """Period totals; averages per bill use non-excluded days when the range contains excluded dates."""
    net = float(daily["net"].sum())
    gross = float(daily["gross_sales"].sum())
    checks = int(daily["checks"].sum())
    qty = float(daily["qty"].sum())
    stat = daily[~daily["excluded"]] if bool(daily["excluded"].any()) and not daily[~daily["excluded"]].empty else daily
    s_net, s_checks, s_qty = float(stat["net"].sum()), int(stat["checks"].sum()), float(stat["qty"].sum())
    active = int((daily["checks"] > 0).sum())
    excluded_days = [d.strftime("%Y-%m-%d") for d in daily.loc[daily["excluded"] & (daily["checks"] > 0), "date"]]
    return {
        "net_sales": round(net, 2),
        "total_sales": round(net, 2),  # alias
        "gross_sales": round(gross, 2),
        "discounts": round(float(daily["discounts"].sum()), 2),
        "returns_total": round(float(daily["returns_total"].sum()), 2),
        "return_count": int(daily["return_count"].sum()),
        "checks": checks,
        "invoice_count": checks,  # alias
        "avg_check": round(s_net / s_checks, 2) if s_checks else 0.0,
        "avg_invoice_value": round(s_net / s_checks, 2) if s_checks else 0.0,  # alias
        "total_qty": round(qty, 3),
        "items_per_check": round(s_qty / s_checks, 2) if s_checks else 0.0,
        "avg_qty_per_invoice": round(s_qty / s_checks, 2) if s_checks else 0.0,  # alias
        "active_days": active,
        "checks_per_trading_day": round(checks / active, 1) if active else 0.0,
        "avg_per_day": round(net / active, 2) if active else 0.0,
        "excluded_days": excluded_days,
    }


def _points(daily: pd.DataFrame, granularity: str) -> list[dict[str, Any]]:
    """Per-day (or per-month) net sales and bills, gaps filled with zero."""
    if daily.empty:
        return []
    if granularity == "month":
        g = daily.groupby(daily["date"].dt.to_period("M")).agg(net=("net", "sum"), checks=("checks", "sum")).reset_index()
        g["date"] = g["date"].dt.to_timestamp()
        src = g
    else:
        src = daily
    return [
        {"period": d.strftime("%Y-%m-%d"), "total": round(float(t), 2), "invoice_count": int(n), "checks": int(n)}
        for d, t, n in zip(src["date"], src["net"], src["checks"])
    ]


DELTA_KEYS = ("net_sales", "total_sales", "gross_sales", "returns_total", "checks", "invoice_count", "return_count",
              "avg_check", "avg_invoice_value", "total_qty", "items_per_check", "avg_qty_per_invoice", "active_days", "avg_per_day",
              "checks_per_trading_day", "discounts")


def _deltas(cur: dict[str, Any], prev: dict[str, Any]) -> dict[str, float | None]:
    return {k: _pct(float(cur[k]), float(prev[k])) for k in DELTA_KEYS if k in cur and k in prev}


def comparison_range(rng: DateRange, mode: str = "previous", cmp_start: date | None = None, cmp_end: date | None = None) -> DateRange:
    """Which period the current range is compared against.

    previous   -> the same-length window immediately before (default)
    last_week  -> the same dates one week earlier (weekday-aligned)
    last_year  -> the same dates one year earlier
    custom     -> any explicit cmp_start / cmp_end
    """
    if mode == "last_week":
        return rng.shift(-7)
    if mode == "last_year":
        return DateRange(_shift_year(rng.start), _shift_year(rng.end))
    if mode == "custom" and cmp_start and cmp_end:
        return DateRange(cmp_start, cmp_end)
    return rng.previous()


def _shift_year(d: date, years: int = -1) -> date:
    try:
        return d.replace(year=d.year + years)
    except ValueError:  # 29 Feb
        return d.replace(year=d.year + years, day=28)


# ------------------------------------------------------------------ headline

async def _health(rng: DateRange) -> dict[str, Any]:
    """Data freshness and exceptions: last bill keyed, drafts, unconsolidated, cancelled in range."""
    async def _load() -> dict[str, Any]:
        c = get_client()
        excluded = sorted(_excluded())
        last, drafts, unconsolidated, cancelled = await asyncio.gather(
            c.get_list("POS Invoice", ["posting_date", "posting_time"], [["docstatus", "=", 1], ["company", "=", c.company]],
                       order_by="posting_date desc, posting_time desc", limit_page_length=1),
            c.get_count("POS Invoice", [["docstatus", "=", 0], ["company", "=", c.company]]),
            c.get_count("POS Invoice", [["docstatus", "=", 1], ["company", "=", c.company], ["status", "!=", "Consolidated"]]),
            c.get_list("POS Invoice", ["count(name) as n", "sum(base_grand_total) as total"],
                       [["docstatus", "=", 2], ["company", "=", c.company], ["posting_date", ">=", rng.start.isoformat()],
                        ["posting_date", "<=", rng.end.isoformat()], *([["posting_date", "not in", excluded]] if excluded else [])],
                       limit_page_length=1),
        )
        last_row = last[0] if last else {}
        canc = cancelled[0] if cancelled else {}
        last_date = str(last_row.get("posting_date")) if last_row.get("posting_date") else None
        days_without = (today_local() - date.fromisoformat(last_date)).days if last_date else None
        return {
            "last_bill_date": last_date,
            "last_bill_time": fmt_time(last_row.get("posting_time")),
            "days_without_entry": days_without,
            "draft_bills": int(drafts or 0),
            "unconsolidated_bills": int(unconsolidated or 0),
            "cancelled_bills": int(canc.get("n") or 0),
            "cancelled_total": round(float(canc.get("total") or 0), 2),
        }

    value, _ = await cached(f"sales:health:{rng.key()}", _load)
    return value


async def kpis(rng: DateRange, mode: str = "previous", cmp_start: date | None = None, cmp_end: date | None = None,
               refresh: bool = False) -> dict[str, Any]:
    prev_rng = comparison_range(rng, mode, cmp_start, cmp_end)
    cur_df, prev_df, health = await asyncio.gather(_check_days(rng, refresh), _check_days(prev_rng), _health(rng))
    cur_daily, prev_daily = _daily(cur_df, rng), _daily(prev_df, prev_rng)
    current, previous = _totals_from_days(cur_daily), _totals_from_days(prev_daily)
    health = {**health, "calendar_days": rng.days, "trading_days": current["active_days"],
              "returns": {"count": current["return_count"], "amount": current["returns_total"],
                          "pct_of_gross": round(abs(current["returns_total"]) / current["gross_sales"] * 100, 1) if current["gross_sales"] else 0.0},
              "discounts": {"amount": current["discounts"],
                            "pct_of_gross": round(current["discounts"] / current["gross_sales"] * 100, 1) if current["gross_sales"] else 0.0}}
    return {
        "source": "pos_invoice",
        "range": rng.as_dict(),
        "mode": mode,
        "previous_range": prev_rng.as_dict(),
        "current": current,
        "previous": previous,
        "delta_pct": _deltas(current, previous),
        "health": health,
        "excluded_days": current["excluded_days"],
    }


async def invoices(rng: DateRange) -> dict[str, Any]:
    rows = await get_client().get_all(
        "Sales Invoice", INVOICE_FIELDS, _base_filters(rng), order_by="posting_date desc, posting_time desc",
    )
    for r in rows:
        r["outlet"] = outlet_label(r.get("cost_center"), r.get("pos_profile"), r.get("set_warehouse"))
        r["posting_time"] = fmt_time(r.get("posting_time"))
    return {"source": "sales_invoice", "range": rng.as_dict(), "count": len(rows), "invoices": rows,
            "note": "one Sales Invoice = one till closing (several bills)"}


async def trend(rng: DateRange) -> dict[str, Any]:
    daily = _daily(await _check_days(rng), rng)
    return {"source": "pos_invoice", "range": rng.as_dict(), "granularity": rng.granularity, "points": _points(daily, rng.granularity)}


# ------------------------------------------------------------------ items

async def _item_frame(rng: DateRange, refresh: bool = False) -> pd.DataFrame:
    """One row per item sold in the range (item_code, item_name, item_group, qty, amount), sorted by amount desc."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        out: list[dict[str, Any]] = []
        for parent_dt, child_dt, extra in ITEM_SOURCES:
            names = [r["name"] for r in await c.get_all(parent_dt, ["name"], live._filters(rng, extra + [["is_return", "=", 0]]))]
            if not names:
                continue
            chunks = [names[i:i + ITEM_CHUNK] for i in range(0, len(names), ITEM_CHUNK)]
            results = await asyncio.gather(*[
                c.get_list(
                    child_dt,
                    ["item_code", "item_name", "item_group", "sum(qty) as qty", "sum(base_amount) as amount"],
                    [["parent", "in", chunk]], group_by="item_code", parent=parent_dt, limit_page_length=None,
                )
                for chunk in chunks
            ])
            out.extend(r for chunk in results for r in chunk)
        return out

    rows, _ = await cached(f"sales:items:{rng.key()}", _load, refresh=_refresh_ok(rng, refresh))
    df = pd.DataFrame(rows, columns=["item_code", "item_name", "item_group", "qty", "amount"])
    if df.empty:
        return df
    df["qty"] = pd.to_numeric(df["qty"], errors="coerce").fillna(0.0)
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce").fillna(0.0)
    df = df.groupby(["item_code"], as_index=False).agg(
        item_name=("item_name", "first"), item_group=("item_group", "first"), qty=("qty", "sum"), amount=("amount", "sum")
    ).sort_values("amount", ascending=False).reset_index(drop=True)
    df["item_name"] = df["item_name"].fillna(df["item_code"])
    df["item_group"] = df["item_group"].fillna("Ungrouped")
    return df


async def top_items(rng: DateRange, limit: int = 10, refresh: bool = False) -> dict[str, Any]:
    df = await _item_frame(rng, refresh)
    if df.empty:
        return {"source": "pos_invoice_item", "range": rng.as_dict(), "items": [], "other_amount": 0.0,
                "total_amount": 0.0, "distinct_items": 0}
    total = float(df["amount"].sum())
    top = df.head(limit)
    items = [
        {
            "item_code": r.item_code, "item_name": r.item_name or r.item_code, "item_group": r.item_group,
            "qty": round(float(r.qty), 3), "amount": round(float(r.amount), 2),
            "share_pct": round(float(r.amount) / total * 100, 1) if total else 0.0,
        }
        for r in top.itertuples()
    ]
    other = float(df.iloc[limit:]["amount"].sum()) if len(df) > limit else 0.0
    return {
        "source": "pos_invoice_item", "range": rng.as_dict(), "items": items,
        "other_amount": round(other, 2), "total_amount": round(total, 2), "distinct_items": int(len(df)),
    }


async def by_item_group(rng: DateRange, refresh: bool = False) -> dict[str, Any]:
    df = await _item_frame(rng, refresh)
    empty = {"source": "pos_invoice_item", "range": rng.as_dict(), "groups": [], "total_amount": 0.0}
    if df.empty:
        return empty
    g = df.groupby("item_group", as_index=False).agg(qty=("qty", "sum"), amount=("amount", "sum"), items=("item_code", "nunique"))
    g = g.sort_values("amount", ascending=False)
    total = float(g["amount"].sum())
    groups = [
        {"item_group": r.item_group, "qty": round(float(r.qty), 3), "amount": round(float(r.amount), 2),
         "items": int(r.items), "share_pct": round(float(r.amount) / total * 100, 1) if total else 0.0}
        for r in g.itertuples()
    ]
    return {**empty, "groups": groups, "total_amount": round(total, 2)}


def _merge_items(cur: pd.DataFrame, prev: pd.DataFrame) -> pd.DataFrame:
    cols = ["item_code", "item_name", "item_group", "qty", "amount"]
    a = cur if not cur.empty else pd.DataFrame(columns=cols)
    b = prev if not prev.empty else pd.DataFrame(columns=cols)
    m = a.merge(b, on="item_code", how="outer", suffixes=("_c", "_p"))
    m["item_name"] = m["item_name_c"].fillna(m["item_name_p"]).fillna(m["item_code"])
    m["item_group"] = m["item_group_c"].fillna(m["item_group_p"]).fillna("Ungrouped")
    for col in ("qty_c", "qty_p", "amount_c", "amount_p"):
        m[col] = pd.to_numeric(m[col], errors="coerce").fillna(0.0).astype(float)
    m["delta_abs"] = m["amount_c"] - m["amount_p"]
    return m


async def pmix(rng: DateRange, mode: str = "previous", cmp_start: date | None = None, cmp_end: date | None = None,
               refresh: bool = False) -> dict[str, Any]:
    """Product mix: every item sold in the range with qty / value shares and the change vs the comparison period."""
    prev_rng = comparison_range(rng, mode, cmp_start, cmp_end)
    cur, prev = await asyncio.gather(_item_frame(rng, refresh), _item_frame(prev_rng))
    m = _merge_items(cur, prev)
    total_qty = float(m["qty_c"].sum())
    total_sales = float(m["amount_c"].sum())
    items = []
    for r in m.itertuples():
        items.append({
            "item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group,
            "qty": round(r.qty_c, 3), "net_sales": round(r.amount_c, 2),
            "qty_share_pct": round(r.qty_c / total_qty * 100, 1) if total_qty else 0.0,
            "sales_share_pct": round(r.amount_c / total_sales * 100, 1) if total_sales else 0.0,
            "avg_price": round(r.amount_c / r.qty_c, 2) if r.qty_c else 0.0,
            "prev_qty": round(r.qty_p, 3), "prev_net_sales": round(r.amount_p, 2),
            "delta_qty_pct": _pct(r.qty_c, r.qty_p), "delta_sales_pct": _pct(r.amount_c, r.amount_p),
            "delta_sales_abs": round(r.delta_abs, 2),
            "is_new": bool(r.amount_p == 0 and r.amount_c > 0),
            "is_dropped": bool(r.amount_c == 0 and r.amount_p > 0),
            "is_declining": bool(r.amount_p > 0 and r.amount_c > 0 and (r.amount_c - r.amount_p) / r.amount_p <= -0.3),
        })
    items.sort(key=lambda x: -x["qty"])
    sold = [i for i in items if i["net_sales"] > 0]
    top5 = sorted(sold, key=lambda x: -x["net_sales"])[:5]
    g = cur.groupby("item_group", as_index=False).agg(qty=("qty", "sum"), amount=("amount", "sum"), items=("item_code", "nunique")) if not cur.empty else pd.DataFrame(columns=["item_group", "qty", "amount", "items"])
    groups = [
        {"item_group": r.item_group, "qty": round(float(r.qty), 3), "net_sales": round(float(r.amount), 2),
         "share_pct": round(float(r.amount) / total_sales * 100, 1) if total_sales else 0.0, "items": int(r.items)}
        for r in g.sort_values("amount", ascending=False).itertuples()
    ]
    return {
        "source": "pos_invoice_item", "range": rng.as_dict(), "previous_range": prev_rng.as_dict(), "mode": mode,
        "items": items, "groups": groups,
        "totals": {"qty": round(total_qty, 3), "net_sales": round(total_sales, 2), "distinct_items": len(sold),
                   "new_items": sum(1 for i in items if i["is_new"]), "dropped_items": sum(1 for i in items if i["is_dropped"]),
                   "declining_items": sum(1 for i in items if i["is_declining"])},
        "top5_share_pct": round(sum(i["net_sales"] for i in top5) / total_sales * 100, 1) if total_sales else 0.0,
    }


async def item_velocity(weeks: int = 4, limit: int = 30, end: date | None = None) -> dict[str, Any]:
    """Typical units per trading day per item over the last `weeks` weeks, for tomorrow's production plan."""
    end = end or today_local()
    window = DateRange(end - timedelta(days=7 * weeks - 1), end)
    next_day = end + timedelta(days=1)
    excluded = _excluded()

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        out: list[dict[str, Any]] = []
        for parent_dt, child_dt, extra in ITEM_SOURCES:
            parents = await c.get_all(parent_dt, ["name", "posting_date"], live._filters(window, extra + [["is_return", "=", 0]]))
            dates = {p["name"]: str(p["posting_date"]) for p in parents}
            names = list(dates)
            if not names:
                continue
            chunks = [names[i:i + ITEM_CHUNK] for i in range(0, len(names), ITEM_CHUNK)]
            results = await asyncio.gather(*[
                c.get_list(child_dt, ["parent", "item_code", "item_name", "item_group", "sum(qty) as qty"],
                           [["parent", "in", chunk]], group_by="parent, item_code", parent=parent_dt, limit_page_length=None)
                for chunk in chunks
            ])
            for chunk in results:
                for r in chunk:
                    out.append({"date": dates.get(r["parent"]), "item_code": r["item_code"], "item_name": r.get("item_name"),
                                "item_group": r.get("item_group"), "qty": float(r.get("qty") or 0)})
        return out

    rows, _ = await cached(f"sales:velocity:{window.key()}", _load, refresh=False)
    df = pd.DataFrame(rows, columns=["date", "item_code", "item_name", "item_group", "qty"])
    if df.empty:
        return {"source": "pos_invoice_item", "range": window.as_dict(), "next_day": {"date": next_day.isoformat(), "weekday": next_day.strftime("%A")},
                "trading_days": 0, "items": []}
    df = df[~df["date"].isin(excluded)]
    trading_days = sorted(df["date"].unique())
    n_days = len(trading_days)
    per_day = df.groupby(["item_code", "date"], as_index=False)["qty"].sum()
    per_day["weekday"] = pd.to_datetime(per_day["date"]).dt.dayofweek
    wd = next_day.weekday()
    wd_days = [d for d in trading_days if date.fromisoformat(d).weekday() == wd]
    last4 = trading_days[-4:]
    items = []
    meta = df.groupby("item_code").agg(item_name=("item_name", "first"), item_group=("item_group", "first"), total=("qty", "sum"))
    for code, m in meta.iterrows():
        sub = per_day[per_day["item_code"] == code]
        by_date = dict(zip(sub["date"], sub["qty"]))
        wd_q = [by_date.get(d, 0.0) for d in wd_days]
        items.append({
            "item_code": code, "item_name": m["item_name"] or code, "item_group": m["item_group"],
            "total_qty": round(float(m["total"]), 3),
            "typical_qty": round(float(m["total"]) / n_days, 1) if n_days else 0.0,
            "weekday_qty": round(sum(wd_q) / len(wd_q), 1) if wd_q else None,
            "weekday_n": len(wd_days),
            "days_sold": int(len(sub)),
            "last_4_days": [round(by_date.get(d, 0.0), 1) for d in last4],
        })
    items.sort(key=lambda x: -x["typical_qty"])
    return {
        "source": "pos_invoice_item", "range": window.as_dict(),
        "next_day": {"date": next_day.isoformat(), "weekday": next_day.strftime("%A")},
        "trading_days": n_days, "last_4_dates": last4, "weekday_dates": wd_days,
        "items": items[:limit], "distinct_items": len(items),
    }


# ------------------------------------------------------------------ outlets, customers, payments

async def by_outlet(rng: DateRange) -> dict[str, Any]:
    rows = await get_client().get_list(
        "POS Invoice",
        ["cost_center", "pos_profile", "set_warehouse", "sum(base_grand_total) as total", "count(name) as invoice_count"],
        live._filters(rng, [["is_return", "=", 0]]),
        group_by="cost_center, pos_profile",
        order_by="total desc",
        limit_page_length=None,
    )
    outlets = []
    grand = sum(float(r.get("total") or 0) for r in rows)
    for r in rows:
        total = float(r.get("total") or 0)
        count = int(r.get("invoice_count") or 0)
        outlets.append({
            "outlet": outlet_label(r.get("cost_center"), r.get("pos_profile"), r.get("set_warehouse")),
            "cost_center": r.get("cost_center"), "pos_profile": r.get("pos_profile"),
            "total": round(total, 2), "invoice_count": count, "checks": count,
            "avg_invoice_value": round(total / count, 2) if count else 0.0,
            "outstanding": 0.0,
            "share_pct": round(total / grand * 100, 1) if grand else 0.0,
        })
    return {"source": "pos_invoice", "range": rng.as_dict(), "outlets": outlets, "total": round(grand, 2)}


async def top_customers(rng: DateRange, limit: int = 10) -> dict[str, Any]:
    rows = await get_client().get_list(
        "POS Invoice",
        ["customer", "customer_name", "sum(base_grand_total) as total", "count(name) as invoice_count", "max(posting_date) as last_invoice"],
        live._filters(rng, [["is_return", "=", 0]]), group_by="customer", order_by="total desc", limit_page_length=None,
    )
    grand = sum(float(r.get("total") or 0) for r in rows)
    customers = []
    for r in rows[:limit]:
        total = float(r.get("total") or 0)
        count = int(r.get("invoice_count") or 0)
        customers.append({
            "customer": r["customer"], "customer_name": r.get("customer_name") or r["customer"],
            "total": round(total, 2), "invoice_count": count, "checks": count,
            "avg_invoice_value": round(total / count, 2) if count else 0.0,
            "outstanding": 0.0, "last_invoice": str(r.get("last_invoice") or ""),
            "share_pct": round(total / grand * 100, 1) if grand else 0.0,
        })
    return {"source": "pos_invoice", "range": rng.as_dict(), "customers": customers,
            "distinct_customers": len(rows), "total": round(grand, 2)}


async def payment_modes(rng: DateRange) -> dict[str, Any]:
    c = get_client()
    inv = await c.get_list(
        "POS Invoice", ["name", "base_grand_total", "base_change_amount", "base_rounding_adjustment"],
        live._filters(rng, [["is_return", "=", 0]]), limit_page_length=None,
    )
    names = [r["name"] for r in inv]
    if not names:
        return {"source": "pos_invoice", "range": rng.as_dict(), "modes": [], "total": 0.0}
    chunks = [names[i:i + ITEM_CHUNK] for i in range(0, len(names), ITEM_CHUNK)]
    results = await asyncio.gather(*[
        c.get_list("Sales Invoice Payment", ["mode_of_payment", "sum(base_amount) as amount", "count(name) as n"],
                   [["parent", "in", chunk]], group_by="mode_of_payment", parent="POS Invoice", limit_page_length=None)
        for chunk in chunks
    ])
    paid: dict[str, dict[str, float]] = {}
    for ch in results:
        for r in ch:
            m = r.get("mode_of_payment") or "Unspecified"
            d = paid.setdefault(m, {"amount": 0.0, "n": 0})
            d["amount"] += float(r.get("amount") or 0)
            d["n"] += int(r.get("n") or 0)
    change = sum(float(r.get("base_change_amount") or 0) for r in inv)
    grand = sum(float(r.get("base_grand_total") or 0) for r in inv)
    if change and paid:
        biggest = max(paid, key=lambda k: paid[k]["amount"])
        paid[biggest]["amount"] -= change
    collected = sum(d["amount"] for d in paid.values())
    rounding = sum(float(r.get("base_rounding_adjustment") or 0) for r in inv)
    credit = max(0.0, grand + rounding - collected)
    modes = [{"mode": m, "amount": round(d["amount"], 2), "count": int(d["n"])} for m, d in paid.items()]
    if credit >= 1.0:
        modes.append({"mode": "Credit / Unpaid", "amount": round(credit, 2), "count": 0})
    modes.sort(key=lambda m: m["amount"], reverse=True)
    for m in modes:
        m["share_pct"] = round(m["amount"] / grand * 100, 1) if grand else 0.0
    return {"source": "pos_invoice", "range": rng.as_dict(), "modes": modes, "total": round(grand, 2)}


# ------------------------------------------------------------------ comparison

async def compare(rng: DateRange, mode: str = "previous", cmp_start: date | None = None, cmp_end: date | None = None,
                  refresh: bool = False) -> dict[str, Any]:
    """Current period vs a comparison period, aligned by position (day 1 vs day 1, ...), with
    cumulative running totals and a traffic-vs-spend attribution of the sales change."""
    prev = comparison_range(rng, mode, cmp_start, cmp_end)
    granularity = "day" if max(rng.days, prev.days) <= 92 else "month"
    cur_df, prev_df = await asyncio.gather(_check_days(rng, refresh), _check_days(prev))
    cur_daily, prev_daily = _daily(cur_df, rng), _daily(prev_df, prev)
    cur_pts, prev_pts = _points(cur_daily, granularity), _points(prev_daily, granularity)
    n = max(len(cur_pts), len(prev_pts))
    points = []
    cur_cum = prev_cum = 0.0
    for i in range(n):
        c = cur_pts[i] if i < len(cur_pts) else None
        p = prev_pts[i] if i < len(prev_pts) else None
        if c:
            cur_cum += c["total"]
        if p:
            prev_cum += p["total"]
        points.append({
            "index": i + 1,
            "period": c["period"] if c else None,
            "previous_period": p["period"] if p else None,
            "current": c["total"] if c else None,
            "previous": p["total"] if p else None,
            "current_invoices": c["checks"] if c else None,
            "previous_invoices": p["checks"] if p else None,
            "current_cum": round(cur_cum, 2) if c else None,
            "previous_cum": round(prev_cum, 2) if p else None,
        })
    cur_k, prev_k = _totals_from_days(cur_daily), _totals_from_days(prev_daily)
    attribution = None
    if prev_k["checks"] and cur_k["checks"]:
        delta = cur_k["net_sales"] - prev_k["net_sales"]
        traffic = (cur_k["checks"] - prev_k["checks"]) * prev_k["avg_check"]
        attribution = {
            "delta_sales": round(delta, 2),
            "traffic_effect": round(traffic, 2),
            "spend_effect": round(delta - traffic, 2),
            "traffic_pct": _pct(cur_k["checks"], prev_k["checks"]),
            "spend_pct": _pct(cur_k["avg_check"], prev_k["avg_check"]),
        }
    return {
        "source": "pos_invoice", "range": rng.as_dict(), "previous_range": prev.as_dict(), "mode": mode,
        "granularity": granularity, "points": points,
        "current_total": cur_k["net_sales"], "previous_total": prev_k["net_sales"],
        "delta_pct": _pct(cur_k["net_sales"], prev_k["net_sales"]), "delta_abs": round(cur_k["net_sales"] - prev_k["net_sales"], 2),
        "current": cur_k, "previous": prev_k, "kpi_delta_pct": _deltas(cur_k, prev_k),
        "attribution": attribution,
    }


async def compare_breakdown(rng: DateRange, mode: str = "previous", cmp_start: date | None = None, cmp_end: date | None = None,
                            limit: int = 10, refresh: bool = False) -> dict[str, Any]:
    """Item-group, item and weekday figures side by side for the two periods (what grew, what dropped)."""
    prev = comparison_range(rng, mode, cmp_start, cmp_end)
    cg, pg, ci, pi, cw, pw = await asyncio.gather(
        by_item_group(rng, refresh), by_item_group(prev), _item_frame(rng, refresh), _item_frame(prev), by_weekday(rng, refresh), by_weekday(prev),
    )

    def _merge_groups() -> list[dict[str, Any]]:
        cur = {g["item_group"]: g for g in cg["groups"]}
        prv = {g["item_group"]: g for g in pg["groups"]}
        out = []
        for name in sorted(set(cur) | set(prv), key=lambda k: -(cur.get(k, {}).get("amount", 0.0))):
            c, p = cur.get(name, {}), prv.get(name, {})
            ca, pa = float(c.get("amount", 0.0)), float(p.get("amount", 0.0))
            out.append({"label": name, "current": round(ca, 2), "previous": round(pa, 2), "delta_abs": round(ca - pa, 2),
                        "delta_pct": _pct(ca, pa), "current_qty": c.get("qty", 0.0), "previous_qty": p.get("qty", 0.0),
                        "current_share_pct": c.get("share_pct", 0.0), "previous_share_pct": p.get("share_pct", 0.0)})
        return out

    m = _merge_items(ci, pi)
    rows = [
        {"item_code": r.item_code, "label": r.item_name, "item_group": r.item_group if isinstance(r.item_group, str) else None,
         "current": round(r.amount_c, 2), "previous": round(r.amount_p, 2), "delta_abs": round(r.delta_abs, 2),
         "delta_pct": _pct(r.amount_c, r.amount_p), "current_qty": round(r.qty_c, 3), "previous_qty": round(r.qty_p, 3)}
        for r in m.itertuples()
    ]
    top = sorted(rows, key=lambda r: -r["current"])[:limit]
    bottom = sorted((r for r in rows if r["current"] > 0), key=lambda r: r["current"])[:limit]
    dropped = sum(1 for r in rows if r["current"] == 0 and r["previous"] > 0)
    gainers = [r for r in sorted(rows, key=lambda r: -r["delta_abs"]) if r["delta_abs"] > 0][:limit]
    losers = [r for r in sorted(rows, key=lambda r: r["delta_abs"]) if r["delta_abs"] < 0][:limit]
    weekdays = []
    for c, p in zip(cw["points"], pw["points"]):
        weekdays.append({"label": c["weekday"], "current": c["avg_per_trading_day"], "previous": p["avg_per_trading_day"],
                         "current_total": c["total"], "previous_total": p["total"],
                         "current_n": c["trading_days"], "previous_n": p["trading_days"],
                         "delta_pct": _pct(c["avg_per_trading_day"], p["avg_per_trading_day"])})
    return {
        "source": "pos_invoice_item", "range": rng.as_dict(), "previous_range": prev.as_dict(), "mode": mode,
        "item_groups": _merge_groups(), "top_items": top, "bottom_items": bottom, "gainers": gainers, "losers": losers,
        "weekdays": weekdays,
        "new_items": int(sum(1 for r in top if r["previous"] == 0)),
        "dropped_items": int(dropped),
    }


# ------------------------------------------------------------------ patterns

async def by_hour(rng: DateRange, refresh: bool = False) -> dict[str, Any]:
    """Bills per hour of ENTRY (posting_time is when the bill was keyed in, not the customer's time)."""
    df = await _check_rows(rng, refresh)
    sales_df = df[(df["is_return"] == 0) & (~df["date"].isin(_excluded()))] if not df.empty else df
    active_days = int(sales_df["date"].nunique()) if not sales_df.empty else 0
    points = []
    for h in range(24):
        sub = sales_df[sales_df["hour"] == h] if not sales_df.empty else sales_df
        total = float(sub["total"].sum()) if not sub.empty else 0.0
        points.append({"hour": h, "label": f"{h:02d}:00", "total": round(total, 2), "invoice_count": int(len(sub)), "checks": int(len(sub)),
                       "avg_per_day": round(total / active_days, 2) if active_days else 0.0})
    return {"source": "pos_invoice", "range": rng.as_dict(), "active_days": active_days, "points": points,
            "peak_hour": None, "note": "entry time (till keying), not customer time"}


async def by_weekday(rng: DateRange, refresh: bool = False) -> dict[str, Any]:
    daily = _daily(await _check_days(rng, refresh), rng)
    stat = daily[~daily["excluded"]]
    points = []
    for i, name in enumerate(WEEKDAYS):
        sub = stat[stat["date"].dt.dayofweek == i]
        traded = sub[sub["checks"] > 0]
        total = float(sub["net"].sum())
        occ = int((daily["date"].dt.dayofweek == i).sum())
        n = int(len(traded))
        points.append({
            "weekday": name, "total": round(total, 2), "invoice_count": int(sub["checks"].sum()), "checks": int(sub["checks"].sum()),
            "occurrences": occ, "trading_days": n,
            "avg_per_day": round(total / occ, 2) if occ else 0.0,
            "avg_per_trading_day": round(total / n, 2) if n else 0.0,
            "avg_checks_per_trading_day": round(float(traded["checks"].sum()) / n, 1) if n else 0.0,
        })
    traded_pts = [p for p in points if p["trading_days"]]
    best = max(traded_pts, key=lambda p: p["avg_per_trading_day"]) if traded_pts else None
    return {"source": "pos_invoice", "range": rng.as_dict(), "points": points,
            "best_weekday": best["weekday"] if best else None, "excluded_days": _totals_from_days(daily)["excluded_days"]}


async def weekly(week_start: date, refresh: bool = False) -> dict[str, Any]:
    """This week day by day vs last week vs the average of the same weekday over the previous 4 weeks."""
    week_start = week_start - timedelta(days=week_start.weekday())  # Monday
    week_end = week_start + timedelta(days=6)
    window = DateRange(week_start - timedelta(days=28), week_end)
    daily = _daily(await _check_days(window, refresh), window)
    by_date = {d.strftime("%Y-%m-%d"): row for d, row in zip(daily["date"], daily.to_dict("records"))}
    today = today_local()

    def _fig(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        checks = int(row["checks"])
        return {"date": row["date"].strftime("%Y-%m-%d"), "net_sales": round(float(row["net"]), 2), "checks": checks,
                "avg_check": round(float(row["net"]) / checks, 2) if checks else 0.0, "qty": round(float(row["qty"]), 3),
                "excluded": bool(row["excluded"])}

    days = []
    week_total = 0.0
    for i in range(7):
        d = week_start + timedelta(days=i)
        cur = _fig(by_date.get(d.isoformat()))
        lw = _fig(by_date.get((d - timedelta(days=7)).isoformat()))
        prev4 = [by_date.get((d - timedelta(days=7 * k)).isoformat()) for k in range(1, 5)]
        traded = [r for r in prev4 if r is not None and r["checks"] > 0 and not r["excluded"]]
        avg4 = None
        if traded:
            s = sum(float(r["net"]) for r in traded)
            c = sum(int(r["checks"]) for r in traded)
            avg4 = {"net_sales": round(s / len(traded), 2), "checks": round(c / len(traded), 1),
                    "avg_check": round(s / c, 2) if c else 0.0, "trading_weeks": len(traded)}
        net = cur["net_sales"] if cur else 0.0
        week_total += net
        days.append({
            "weekday": WEEKDAYS[i], "date": d.isoformat(), "is_today": d == today, "is_future": d > today,
            "net_sales": net, "checks": cur["checks"] if cur else 0, "avg_check": cur["avg_check"] if cur else 0.0,
            "qty": cur["qty"] if cur else 0.0, "excluded": cur["excluded"] if cur else False,
            "last_week": lw if lw and lw["checks"] else None,
            "avg4": avg4,
            "delta_vs_last_week_pct": _pct(net, lw["net_sales"]) if lw and lw["checks"] else None,
            "delta_vs_avg4_pct": _pct(net, avg4["net_sales"]) if avg4 and avg4["trading_weeks"] >= 2 else None,
        })
    for dd in days:
        dd["share_of_week_pct"] = round(dd["net_sales"] / week_total * 100, 1) if week_total else 0.0
    upto = [dd for dd in days if not dd["is_future"]]
    wtd_net = sum(dd["net_sales"] for dd in upto)
    wtd_checks = sum(dd["checks"] for dd in upto)
    last_wtd = sum(dd["last_week"]["net_sales"] for dd in upto if dd["last_week"])
    last_wtd_checks = sum(dd["last_week"]["checks"] for dd in upto if dd["last_week"])
    avg4_wtd = sum(dd["avg4"]["net_sales"] for dd in upto if dd["avg4"])
    traded_days = [dd for dd in days if dd["checks"]]
    best = max(traded_days, key=lambda dd: dd["net_sales"]) if traded_days else None
    return {
        "source": "pos_invoice",
        "week": {"start": week_start.isoformat(), "end": week_end.isoformat(), "label": f"{week_start.strftime('%d %b')} – {week_end.strftime('%d %b %Y')}",
                 "is_current": week_start <= today <= week_end, "can_go_back": week_start > DATA_FROM, "can_go_forward": week_end < today},
        "days": days,
        "wtd": {"net_sales": round(wtd_net, 2), "checks": wtd_checks, "avg_check": round(wtd_net / wtd_checks, 2) if wtd_checks else 0.0,
                "last_week_net_sales": round(last_wtd, 2), "last_week_checks": last_wtd_checks,
                "vs_last_week_pct": _pct(wtd_net, last_wtd), "avg4_net_sales": round(avg4_wtd, 2), "vs_avg4_pct": _pct(wtd_net, avg4_wtd),
                "trading_days": len(traded_days)},
        "best_day": {"weekday": best["weekday"], "date": best["date"], "net_sales": best["net_sales"]} if best else None,
        "excluded_days": [dd["date"] for dd in days if dd["excluded"] and dd["checks"]],
    }


async def heatmap(rng: DateRange) -> dict[str, Any]:
    """Average bills value per weekday x ENTRY hour cell (kept for the API; no dashboard card)."""
    df = await _check_rows(rng)
    sales_df = df[(df["is_return"] == 0) & (~df["date"].isin(_excluded()))] if not df.empty else df
    days = pd.date_range(rng.start, rng.end, freq="D")
    occurrences = pd.Series(days.dayofweek).value_counts().to_dict()
    grouped: dict[tuple[int, int], dict[str, float]] = {}
    if not sales_df.empty:
        sub = sales_df.dropna(subset=["hour"]).copy()
        sub["wd"] = pd.to_datetime(sub["date"]).dt.dayofweek
        for (wd, h), g in sub.groupby(["wd", sub["hour"].astype(int)]):
            grouped[(int(wd), int(h))] = {"total": float(g["total"].sum()), "n": int(len(g))}
    cells = []
    max_avg = 0.0
    hours_with_sales: set[int] = set()
    for wd in range(7):
        occ = int(occurrences.get(wd, 0))
        for h in range(24):
            g = grouped.get((wd, h), {})
            total = float(g.get("total", 0.0))
            n = int(g.get("n", 0))
            avg = total / occ if occ else 0.0
            if total:
                hours_with_sales.add(h)
            max_avg = max(max_avg, avg)
            cells.append({"weekday": WEEKDAYS[wd], "weekday_index": wd, "hour": h, "total": round(total, 2),
                          "invoice_count": n, "occurrences": occ, "avg_per_day": round(avg, 2)})
    peak = max(cells, key=lambda c: c["avg_per_day"]) if max_avg else None
    return {
        "source": "pos_invoice", "range": rng.as_dict(), "weekdays": WEEKDAYS, "cells": cells, "max_avg": round(max_avg, 2),
        "hour_min": min(hours_with_sales) if hours_with_sales else 0, "hour_max": max(hours_with_sales) if hours_with_sales else 23,
        "peak": {"weekday": peak["weekday"], "hour": peak["hour"], "avg_per_day": peak["avg_per_day"]} if peak else None,
        "note": "entry time (till keying), not customer time",
    }


VALUE_BUCKETS = [
    (0, 1_000, "< 1K"), (1_000, 5_000, "1K-5K"), (5_000, 10_000, "5K-10K"), (10_000, 25_000, "10K-25K"),
    (25_000, 50_000, "25K-50K"), (50_000, 100_000, "50K-100K"), (100_000, 500_000, "100K-500K"),
    (500_000, 1_000_000, "500K-1M"), (1_000_000, float("inf"), "> 1M"),
]


async def invoice_distribution(rng: DateRange) -> dict[str, Any]:
    """Bill value histogram (API only)."""
    df = await _check_rows(rng)
    sales_df = df[df["is_return"] == 0] if not df.empty else df
    vals = sales_df["total"] if not sales_df.empty else pd.Series(dtype=float)
    buckets = []
    for lo, hi, label in VALUE_BUCKETS:
        sub = vals[(vals >= lo) & (vals < hi)]
        buckets.append({"bucket": label, "min": lo, "max": None if hi == float("inf") else hi,
                        "invoice_count": int(len(sub)), "total": round(float(sub.sum()), 2)})
    n = int(len(vals))
    stats = {
        "count": n,
        "median": round(float(vals.median()), 2) if n else 0.0,
        "mean": round(float(vals.mean()), 2) if n else 0.0,
        "min": round(float(vals.min()), 2) if n else 0.0,
        "max": round(float(vals.max()), 2) if n else 0.0,
        "p90": round(float(vals.quantile(0.9)), 2) if n else 0.0,
    }
    return {"source": "pos_invoice", "range": rng.as_dict(), "buckets": buckets, "stats": stats}


async def item_pareto(rng: DateRange, limit: int = 30) -> dict[str, Any]:
    """ABC / Pareto analysis (API only)."""
    df = await _item_frame(rng)
    empty = {"source": "pos_invoice_item", "range": rng.as_dict(), "items": [], "classes": [], "distinct_items": 0,
             "total_amount": 0.0, "items_for_80_pct": 0}
    if df.empty:
        return empty
    df = df[df["amount"] > 0].reset_index(drop=True)
    if df.empty:
        return empty
    total = float(df["amount"].sum())
    df["share_pct"] = df["amount"] / total * 100
    df["cum_share_pct"] = df["share_pct"].cumsum()
    before = df["cum_share_pct"] - df["share_pct"]
    df["cls"] = ["A" if b < 80 else "B" if b < 95 else "C" for b in before]
    classes = []
    for k in ("A", "B", "C"):
        sub = df[df["cls"] == k]
        classes.append({"cls": k, "items": int(len(sub)), "amount": round(float(sub["amount"].sum()), 2),
                        "share_pct": round(float(sub["share_pct"].sum()), 1), "items_pct": round(len(sub) / len(df) * 100, 1)})
    items = [
        {"rank": i + 1, "item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group if isinstance(r.item_group, str) else None,
         "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3), "share_pct": round(float(r.share_pct), 2),
         "cum_share_pct": round(float(r.cum_share_pct), 1), "cls": r.cls}
        for i, r in enumerate(df.head(limit).itertuples())
    ]
    return {**empty, "items": items, "classes": classes, "distinct_items": int(len(df)), "total_amount": round(total, 2),
            "items_for_80_pct": int((df["cls"] == "A").sum())}


async def composition(rng: DateRange) -> dict[str, Any]:
    """Gross -> discounts -> taxes -> returns -> net sales (API only; document-level Sales Invoice sums)."""
    c = get_client()
    rows = await c.get_list(
        "Sales Invoice",
        ["sum(base_total) as gross", "sum(base_discount_amount) as discount", "sum(base_net_total) as net",
         "sum(base_total_taxes_and_charges) as taxes", "sum(base_grand_total) as grand", "count(name) as n"],
        _base_filters(rng) + [["is_return", "=", 0]], limit_page_length=1,
    )
    ret = await c.get_list(
        "Sales Invoice", ["sum(base_grand_total) as total", "count(name) as n"],
        _base_filters(rng) + [["is_return", "=", 1]], limit_page_length=1,
    )
    r = rows[0] if rows else {}
    rr = ret[0] if ret else {}
    gross = float(r.get("gross") or 0)
    discount = float(r.get("discount") or 0)
    taxes = float(r.get("taxes") or 0)
    grand = float(r.get("grand") or 0)
    returns = float(rr.get("total") or 0)
    net_sales = grand + returns
    rounding = grand - (gross - discount + taxes)
    steps = [
        {"label": "Gross", "amount": round(gross, 2), "kind": "total"},
        {"label": "Discounts", "amount": round(-discount, 2), "kind": "delta"},
        {"label": "Taxes", "amount": round(taxes, 2), "kind": "delta"},
    ]
    if abs(rounding) >= 0.5:
        steps.append({"label": "Rounding", "amount": round(rounding, 2), "kind": "delta"})
    steps.append({"label": "Returns", "amount": round(returns, 2), "kind": "delta"})
    steps.append({"label": "Net Sales", "amount": round(net_sales, 2), "kind": "total"})
    return {
        "source": "sales_invoice", "range": rng.as_dict(), "steps": steps,
        "gross": round(gross, 2), "discount": round(discount, 2), "taxes": round(taxes, 2),
        "returns": round(returns, 2), "net_sales": round(net_sales, 2),
        "invoice_count": int(r.get("n") or 0), "return_count": int(rr.get("n") or 0),
        "discount_pct": round(discount / gross * 100, 2) if gross else 0.0,
    }


# ------------------------------------------------------------------ history, pace, target

def _month_start(d: date) -> date:
    return d.replace(day=1)


def _add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    return date(d.year + y, m + 1, 1)


async def monthly(rng: DateRange, months: int = 12, refresh: bool = False) -> dict[str, Any]:
    """Net sales, bills and average bill per calendar month for the `months` months ending in the month of
    `rng.end`, with month-over-month and year-over-year growth. Independent of `rng.start`."""
    end_month = _month_start(rng.end)
    first = _add_months(end_month, -(months + 12 - 1))  # extra year so YoY is available
    window = DateRange(first, rng.end)
    daily = _daily(await _check_days(window, refresh), window)
    daily["month"] = daily["date"].dt.strftime("%Y-%m")
    by_month: dict[str, dict[str, Any]] = {}
    for key, g in daily.groupby("month"):
        stat = g[~g["excluded"]]
        s_net, s_checks, s_qty = float(stat["net"].sum()), int(stat["checks"].sum()), float(stat["qty"].sum())
        by_month[str(key)] = {
            "total": float(g["net"].sum()), "checks": int(g["checks"].sum()), "qty": float(g["qty"].sum()),
            "active_days": int((g["checks"] > 0).sum()),
            "avg_check": round(s_net / s_checks, 2) if s_checks else 0.0,
            "items_per_check": round(s_qty / s_checks, 2) if s_checks else 0.0,
            "excluded_days": [d.strftime("%Y-%m-%d") for d in g.loc[g["excluded"] & (g["checks"] > 0), "date"]],
        }
    today = today_local()
    points = []
    for i in range(months):
        m = _add_months(end_month, -(months - 1 - i))
        key = m.strftime("%Y-%m")
        prev_key = _add_months(m, -1).strftime("%Y-%m")
        ly_key = _add_months(m, -12).strftime("%Y-%m")
        cur = by_month.get(key, {"total": 0.0, "checks": 0, "qty": 0.0, "active_days": 0, "avg_check": 0.0, "items_per_check": 0.0, "excluded_days": []})
        prev_total = by_month.get(prev_key, {}).get("total", 0.0)
        ly_total = by_month.get(ly_key, {}).get("total", 0.0)
        days_in_month = calendar.monthrange(m.year, m.month)[1]
        elapsed = min(rng.end, today).day if m == end_month else days_in_month
        is_partial = m == end_month and elapsed < days_in_month
        points.append({
            "period": m.isoformat(), "label": m.strftime("%b %y"), "total": round(cur["total"], 2),
            "invoice_count": cur["checks"], "checks": cur["checks"], "qty": round(cur["qty"], 3),
            "avg_invoice_value": cur["avg_check"], "avg_check": cur["avg_check"], "items_per_check": cur["items_per_check"],
            "active_days": cur["active_days"], "avg_per_day": round(cur["total"] / elapsed, 2) if elapsed else 0.0,
            "avg_per_trading_day": round(cur["total"] / cur["active_days"], 2) if cur["active_days"] else 0.0,
            "mom_pct": _pct(cur["total"], prev_total), "last_year": round(ly_total, 2), "yoy_pct": _pct(cur["total"], ly_total),
            "is_partial": bool(is_partial), "excluded_days": cur["excluded_days"],
        })
    non_zero = [p for p in points if p["total"]]
    clean = [p for p in non_zero if not p["excluded_days"]]
    best = max(clean or non_zero, key=lambda p: p["total"]) if non_zero else None
    complete = [p for p in clean if not p["is_partial"]]
    return {
        "source": "pos_invoice", "range": window.as_dict(), "months": months, "points": points,
        "best_month": best["period"] if best else None,
        "avg_month": round(sum(p["total"] for p in complete) / len(complete), 2) if complete else 0.0,
        "total": round(sum(p["total"] for p in points), 2),
    }


async def run_rate(rng: DateRange, target: float | None = None, refresh: bool = False) -> dict[str, Any]:
    """Daily pace for the range plus the month of `rng.end`: month-to-date, projection on the
    active-day pace, and progress against a monthly target."""
    daily = _daily(await _check_days(rng, refresh), rng)
    stat = daily[~daily["excluded"]]
    active = stat[stat["checks"] > 0]
    total = float(daily["net"].sum())
    best = active.loc[active["net"].idxmax()] if not active.empty else None
    worst = active.loc[active["net"].idxmin()] if not active.empty else None

    today = today_local()
    month_start = _month_start(rng.end)
    days_in_month = calendar.monthrange(rng.end.year, rng.end.month)[1]
    month_end = date(rng.end.year, rng.end.month, days_in_month)
    mtd_end = min(rng.end, today)
    mtd_rng = DateRange(month_start, mtd_end) if mtd_end >= month_start else None
    if mtd_rng is None:
        mdaily = daily.iloc[0:0]
    elif rng.start <= month_start and rng.end >= mtd_end:
        mdaily = daily[(daily["date"] >= pd.Timestamp(month_start)) & (daily["date"] <= pd.Timestamp(mtd_end))]
    else:
        mdaily = _daily(await _check_days(mtd_rng, refresh), mtd_rng)
    mtd = float(mdaily["net"].sum())
    m_stat = mdaily[~mdaily["excluded"]]
    m_active = int((m_stat["checks"] > 0).sum())
    mtd_active_all = int((mdaily["checks"] > 0).sum())
    elapsed = mtd_rng.days if mtd_rng else 0
    remaining_cal = max(0, days_in_month - elapsed)

    # expected trading days ahead: share of calendar days that traded over the trailing 8 weeks
    trail = DateRange(today - timedelta(days=55), today)
    tdaily = _daily(await _check_days(trail), trail)
    ratio = float((tdaily["checks"] > 0).sum()) / trail.days if trail.days else 0.0
    remaining_trading = int(round(remaining_cal * ratio))
    pace = float(m_stat["net"].sum()) / m_active if m_active else 0.0
    projection_basis = "active_day_pace"
    if not m_active and remaining_trading:
        pm = _add_months(month_start, -1)
        pm_rng = DateRange(pm, month_start - timedelta(days=1))
        pdaily = _daily(await _check_days(pm_rng), pm_rng)
        p_stat = pdaily[(~pdaily["excluded"]) & (pdaily["checks"] > 0)]
        pace = float(p_stat["net"].sum()) / len(p_stat) if len(p_stat) else 0.0
        projection_basis = "previous_month_pace"
    projected = mtd + pace * remaining_trading if remaining_cal else mtd

    settings = get_settings()
    month_key = month_start.strftime("%Y-%m")
    target_source = None
    if target and target > 0:
        target_source = "client"
    else:
        target = settings.monthly_target(month_key)
        target_source = "env" if target else None
    target_block = None
    if target:
        attainment = mtd / target * 100
        required = max(target - mtd, 0.0) / remaining_trading if remaining_trading else None
        status = "achieved" if mtd >= target else "on_track" if projected >= 0.95 * target else "at_risk" if projected >= 0.85 * target else "behind"
        target_block = {"amount": round(target, 2), "source": target_source, "attainment_pct": round(attainment, 1),
                        "required_per_trading_day": round(required, 2) if required is not None else None,
                        "remaining_to_target": round(max(target - mtd, 0.0), 2), "status": status}

    return {
        "source": "pos_invoice", "range": rng.as_dict(),
        "total": round(total, 2), "calendar_days": rng.days, "active_days": int((daily["checks"] > 0).sum()),
        "avg_per_day": round(total / rng.days, 2) if rng.days else 0.0,
        "avg_per_active_day": round(float(active["net"].sum()) / len(active), 2) if len(active) else 0.0,
        "avg_checks_per_active_day": round(float(active["checks"].sum()) / len(active), 1) if len(active) else 0.0,
        "best_day": {"date": best["date"].strftime("%Y-%m-%d"), "total": round(float(best["net"]), 2), "invoice_count": int(best["checks"]), "checks": int(best["checks"])} if best is not None else None,
        "worst_day": {"date": worst["date"].strftime("%Y-%m-%d"), "total": round(float(worst["net"]), 2), "invoice_count": int(worst["checks"]), "checks": int(worst["checks"])} if worst is not None else None,
        "excluded_days": [d.strftime("%Y-%m-%d") for d in daily.loc[daily["excluded"] & (daily["checks"] > 0), "date"]],
        "month": {
            "start": month_start.isoformat(), "end": month_end.isoformat(), "label": month_start.strftime("%B %Y"), "key": month_key,
            "days_in_month": days_in_month, "elapsed_days": elapsed, "remaining_days": remaining_cal, "active_days": mtd_active_all,
            "remaining_trading_days": remaining_trading, "expected_trading_ratio": round(ratio, 2),
            "mtd": round(mtd, 2), "avg_per_day": round(mtd / elapsed, 2) if elapsed else 0.0,
            "avg_per_trading_day": round(pace, 2),
            "projected": round(projected, 2), "projection_basis": projection_basis,
            "is_current": month_start == _month_start(today), "is_complete": remaining_cal == 0,
            "target": target_block,
        },
    }


# ------------------------------------------------------------------ morning brief

def rs_pk(v: float) -> str:
    """PKR in the owner's units: 34.2 crore / 64.6 lakh / 7,650."""
    a = abs(v)
    sign = "-" if v < 0 else ""
    if a >= 1e7:
        return f"{sign}PKR {a / 1e7:.2f} crore"
    if a >= 1e5:
        return f"{sign}PKR {a / 1e5:.1f} lakh"
    return f"{sign}PKR {a:,.0f}"


def _chg(p: float | None) -> str:
    if p is None:
        return "pichli baar koi sale nahi thi"
    if p == 0:
        return "barabar"
    return f"{abs(p):.0f}% {'zyada' if p > 0 else 'kam'}"


async def brief(day: date | None = None, target: float | None = None) -> dict[str, Any]:
    """A few Roman Urdu lines the owner can read or forward on WhatsApp: last trading day, month pace, tomorrow's top items."""
    today = today_local()
    if day is None:
        last = await live._last_trading_day(today)
        day = date.fromisoformat(last) if last else today
    rng = DateRange(day, day)
    k, r, v, w = await asyncio.gather(
        kpis(rng, mode="last_week"), run_rate(DateRange(day.replace(day=1), day), target), item_velocity(4, 5, day), weekly(day),
    )
    cur = k["current"]
    name = "Aaj" if day == today else ("Kal" if day == today - timedelta(days=1) else day.strftime("%a %d %b"))
    wd = WEEKDAY_FULL[day.weekday()]
    lines = []
    if cur["checks"]:
        lines.append(f"{name} ({day.strftime('%a %d %b')}): {rs_pk(cur['net_sales'])}, {cur['checks']} bill, avg bill {rs_pk(cur['avg_check'])} - pichle {wd} se {_chg(k['delta_pct'].get('net_sales'))}.")
    else:
        lines.append(f"{name} ({day.strftime('%a %d %b')}): abhi koi bill nahi.")
    m = r["month"]
    if m["target"]:
        t = m["target"]
        req = f", {rs_pk(t['required_per_trading_day'])}/din chahiye ({m['remaining_trading_days']} trading din baqi)" if t["required_per_trading_day"] else ""
        lines.append(f"{m['label']}: {rs_pk(m['mtd'])} ab tak, target ka {t['attainment_pct']:.0f}%{req}. Projected {rs_pk(m['projected'])}.")
    else:
        lines.append(f"{m['label']}: {rs_pk(m['mtd'])} ab tak, {m['active_days']} trading din, projected {rs_pk(m['projected'])}.")
    wt = w["wtd"]
    if wt["checks"]:
        lines.append(f"Is hafte: {rs_pk(wt['net_sales'])}, pichle hafte ke wahi din se {_chg(wt['vs_last_week_pct'])}.")
    if v["items"]:
        nd = v["next_day"]
        tops = ", ".join(f"{i['item_name']} ~{i['weekday_qty'] if i['weekday_n'] >= 3 and i['weekday_qty'] is not None else i['typical_qty']:.0f}" for i in v["items"][:5])
        lines.append(f"Kal ({nd['weekday']}) ka plan, typical qty: {tops}.")
    h = k["health"]
    notes = []
    if h.get("draft_bills"):
        notes.append(f"{h['draft_bills']} draft bill pending")
    if h.get("unconsolidated_bills"):
        notes.append(f"{h['unconsolidated_bills']} bill ka closing baqi")
    if h.get("cancelled_bills"):
        notes.append(f"{h['cancelled_bills']} bill cancel hue")
    if notes:
        lines.append("Note: " + ", ".join(notes) + ".")
    return {"date": day.isoformat(), "lines": lines, "text": "\n".join(lines), "source": "pos_invoice"}
