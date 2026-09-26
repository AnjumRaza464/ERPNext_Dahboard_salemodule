"""Sales figures straight from Sales Invoice / Sales Invoice Item."""
from __future__ import annotations

import asyncio
import calendar
from datetime import date
from typing import Any

import pandas as pd

from ..dates import DateRange
from ..erpnext_client import get_client

INVOICE_FIELDS = [
    "name", "posting_date", "posting_time", "customer", "customer_name",
    "base_grand_total", "base_net_total", "total_taxes_and_charges", "discount_amount",
    "outstanding_amount", "status", "is_return", "is_pos", "cost_center",
    "pos_profile", "set_warehouse", "total_qty", "due_date",
]


def _base_filters(rng: DateRange) -> list[list[Any]]:
    c = get_client()
    return [
        ["docstatus", "=", 1],
        ["company", "=", c.company],
        ["posting_date", ">=", rng.start.isoformat()],
        ["posting_date", "<=", rng.end.isoformat()],
    ]


def outlet_label(cost_center: str | None, pos_profile: str | None = None, warehouse: str | None = None) -> str:
    raw = cost_center or pos_profile or warehouse or "Unassigned"
    abbr = f" - {get_client().company.split()[0][:1]}"  # not reliable; strip generic suffix below
    label = raw.strip()
    # Strip the trailing " - <ABBR>" company suffix ERPNext appends to account/cost-center names
    if " - " in label:
        head, _, tail = label.rpartition(" - ")
        if tail.isupper() and len(tail) <= 5:
            label = head
    _ = abbr
    return label.strip() or "Unassigned"


async def _period_totals(rng: DateRange) -> dict[str, float]:
    c = get_client()
    rows = await c.get_list(
        "Sales Invoice",
        ["count(name) as invoice_count", "sum(base_grand_total) as total_sales",
         "sum(outstanding_amount) as outstanding", "sum(total_qty) as total_qty"],
        _base_filters(rng) + [["is_return", "=", 0]],
        limit_page_length=1,
    )
    returns = await c.get_list(
        "Sales Invoice",
        ["count(name) as return_count", "sum(base_grand_total) as return_total"],
        _base_filters(rng) + [["is_return", "=", 1]],
        limit_page_length=1,
    )
    r = rows[0] if rows else {}
    ret = returns[0] if returns else {}
    gross = float(r.get("total_sales") or 0)
    ret_total = float(ret.get("return_total") or 0)  # negative in ERPNext
    count = int(r.get("invoice_count") or 0)
    net = gross + ret_total
    return {
        "total_sales": round(net, 2),
        "gross_sales": round(gross, 2),
        "returns_total": round(ret_total, 2),
        "invoice_count": count,
        "return_count": int(ret.get("return_count") or 0),
        "avg_invoice_value": round(gross / count, 2) if count else 0.0,
        "outstanding": round(float(r.get("outstanding") or 0), 2),
        "total_qty": round(float(r.get("total_qty") or 0), 3),
    }


async def kpis(rng: DateRange) -> dict[str, Any]:
    current, previous = await asyncio.gather(_period_totals(rng), _period_totals(rng.previous()))
    deltas = {}
    for k in ("total_sales", "invoice_count", "avg_invoice_value", "outstanding", "total_qty"):
        prev = previous[k]
        deltas[k] = round((current[k] - prev) / prev * 100, 1) if prev else None
    return {
        "source": "sales_invoice",
        "range": rng.as_dict(),
        "previous_range": rng.previous().as_dict(),
        "current": current,
        "previous": previous,
        "delta_pct": deltas,
    }


async def invoices(rng: DateRange) -> dict[str, Any]:
    rows = await get_client().get_all(
        "Sales Invoice", INVOICE_FIELDS, _base_filters(rng), order_by="posting_date desc, posting_time desc",
    )
    for r in rows:
        r["outlet"] = outlet_label(r.get("cost_center"), r.get("pos_profile"), r.get("set_warehouse"))
        if r.get("posting_time"):
            r["posting_time"] = str(r["posting_time"])[:8]
    return {"source": "sales_invoice", "range": rng.as_dict(), "count": len(rows), "invoices": rows}


async def _trend_points(rng: DateRange, granularity: str | None = None) -> tuple[str, list[dict[str, Any]]]:
    """Per-day (or per-month) net sales for the range, gaps filled with zero."""
    rows = await get_client().get_list(
        "Sales Invoice",
        ["posting_date", "sum(base_grand_total) as total", "count(name) as invoice_count"],
        _base_filters(rng),
        group_by="posting_date",
        order_by="posting_date asc",
        limit_page_length=None,
    )
    df = pd.DataFrame(rows, columns=["posting_date", "total", "invoice_count"])
    granularity = granularity or rng.granularity
    if df.empty:
        return granularity, []
    df["posting_date"] = pd.to_datetime(df["posting_date"])
    # Fill missing days with zero so the line does not skip gaps
    full = pd.date_range(rng.start, rng.end, freq="D")
    df = df.set_index("posting_date").reindex(full, fill_value=0).rename_axis("period").reset_index()
    if granularity == "month":
        df = df.groupby(df["period"].dt.to_period("M")).agg({"total": "sum", "invoice_count": "sum"}).reset_index()
        df["period"] = df["period"].dt.to_timestamp()
    points = [
        {"period": p.strftime("%Y-%m-%d"), "total": round(float(t), 2), "invoice_count": int(n)}
        for p, t, n in zip(df["period"], df["total"], df["invoice_count"])
    ]
    return granularity, points


async def trend(rng: DateRange) -> dict[str, Any]:
    granularity, points = await _trend_points(rng)
    return {"source": "sales_invoice", "range": rng.as_dict(), "granularity": granularity, "points": points}


async def _item_frame(rng: DateRange) -> pd.DataFrame:
    """One row per item sold in the range (item_code, item_name, item_group, qty, amount), sorted by amount desc."""
    from ..cache import cached

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        names = [r["name"] for r in await c.get_all("Sales Invoice", ["name"], _base_filters(rng))]
        if not names:
            return []
        chunks = [names[i:i + 200] for i in range(0, len(names), 200)]
        results = await asyncio.gather(*[
            c.get_list(
                "Sales Invoice Item",
                ["item_code", "item_name", "item_group", "sum(qty) as qty", "sum(base_amount) as amount"],
                [["parent", "in", chunk]],
                group_by="item_code",
                parent="Sales Invoice",
                limit_page_length=None,
            )
            for chunk in chunks
        ])
        return [r for chunk in results for r in chunk]

    rows, _ = await cached(f"sales:items:{rng.key()}", _load)
    df = pd.DataFrame(rows, columns=["item_code", "item_name", "item_group", "qty", "amount"])
    if df.empty:
        return df
    df["qty"] = df["qty"].astype(float)
    df["amount"] = df["amount"].astype(float)
    df = df.groupby(["item_code"], as_index=False).agg(
        item_name=("item_name", "first"), item_group=("item_group", "first"), qty=("qty", "sum"), amount=("amount", "sum")
    ).sort_values("amount", ascending=False).reset_index(drop=True)
    df["item_name"] = df["item_name"].fillna(df["item_code"])
    return df


async def top_items(rng: DateRange, limit: int = 10) -> dict[str, Any]:
    df = await _item_frame(rng)
    if df.empty:
        return {"source": "sales_invoice_item", "range": rng.as_dict(), "items": [], "other_amount": 0.0,
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
        "source": "sales_invoice_item", "range": rng.as_dict(), "items": items,
        "other_amount": round(other, 2), "total_amount": round(total, 2), "distinct_items": int(len(df)),
    }


async def by_outlet(rng: DateRange) -> dict[str, Any]:
    rows = await get_client().get_list(
        "Sales Invoice",
        ["cost_center", "pos_profile", "set_warehouse", "sum(base_grand_total) as total",
         "count(name) as invoice_count", "sum(outstanding_amount) as outstanding"],
        _base_filters(rng),
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
            "total": round(total, 2), "invoice_count": count,
            "avg_invoice_value": round(total / count, 2) if count else 0.0,
            "outstanding": round(float(r.get("outstanding") or 0), 2),
            "share_pct": round(total / grand * 100, 1) if grand else 0.0,
        })
    return {"source": "sales_invoice", "range": rng.as_dict(), "outlets": outlets, "total": round(grand, 2)}


# ------------------------------------------------------------ analytics
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
VALUE_BUCKETS = [
    (0, 1_000, "< 1K"), (1_000, 5_000, "1K-5K"), (5_000, 10_000, "5K-10K"), (10_000, 25_000, "10K-25K"),
    (25_000, 50_000, "25K-50K"), (50_000, 100_000, "50K-100K"), (100_000, 500_000, "100K-500K"),
    (500_000, 1_000_000, "500K-1M"), (1_000_000, float("inf"), "> 1M"),
]


async def _invoice_frame(rng: DateRange) -> pd.DataFrame:
    """Invoice-level rows for the range, shared by the pattern endpoints (cached)."""
    from ..cache import cached  # local import: cache imports config, not services, but keep it lazy

    async def _load() -> list[dict[str, Any]]:
        return await get_client().get_all(
            "Sales Invoice",
            ["name", "posting_date", "posting_time", "customer", "customer_name", "base_grand_total", "total_qty", "is_return"],
            _base_filters(rng),
        )

    rows, _ = await cached(f"sales:frame:{rng.key()}", _load)
    cols = ["name", "posting_date", "posting_time", "customer", "customer_name", "base_grand_total", "total_qty", "is_return"]
    df = pd.DataFrame(rows, columns=cols)
    if df.empty:
        return df
    df["base_grand_total"] = df["base_grand_total"].astype(float)
    df["total_qty"] = df["total_qty"].astype(float)
    df["is_return"] = df["is_return"].fillna(0).astype(int)
    df["posting_date"] = pd.to_datetime(df["posting_date"])
    df["hour"] = pd.to_numeric(df["posting_time"].astype(str).str.slice(0, 2), errors="coerce")
    return df


def _shift_year(d: date, years: int = -1) -> date:
    try:
        return d.replace(year=d.year + years)
    except ValueError:  # 29 Feb
        return d.replace(year=d.year + years, day=28)


def comparison_range(rng: DateRange, mode: str = "previous", cmp_start: date | None = None, cmp_end: date | None = None) -> DateRange:
    """Which period the current range is compared against.

    previous   -> the same-length window immediately before (default)
    last_year  -> the same dates one year earlier
    custom     -> any explicit cmp_start / cmp_end
    """
    if mode == "last_year":
        return DateRange(_shift_year(rng.start), _shift_year(rng.end))
    if mode == "custom" and cmp_start and cmp_end:
        return DateRange(cmp_start, cmp_end)
    return rng.previous()


def _pct(cur: float, prev: float) -> float | None:
    return round((cur - prev) / abs(prev) * 100, 1) if prev else None


async def compare(rng: DateRange, mode: str = "previous", cmp_start: date | None = None, cmp_end: date | None = None) -> dict[str, Any]:
    """Current period vs a comparison period, aligned by position (day 1 vs day 1, ...).

    Both series share one granularity (day unless either window is longer than 92 days),
    and cumulative running totals are included for a pace comparison.
    """
    prev = comparison_range(rng, mode, cmp_start, cmp_end)
    granularity = "day" if max(rng.days, prev.days) <= 92 else "month"
    (_, cur_pts), (_, prev_pts), cur_k, prev_k = await asyncio.gather(
        _trend_points(rng, granularity), _trend_points(prev, granularity), _period_totals(rng), _period_totals(prev),
    )
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
            "current_invoices": c["invoice_count"] if c else None,
            "previous_invoices": p["invoice_count"] if p else None,
            "current_cum": round(cur_cum, 2) if c else None,
            "previous_cum": round(prev_cum, 2) if p else None,
        })
    cur_total = sum(p["total"] for p in cur_pts)
    prev_total = sum(p["total"] for p in prev_pts)
    kpi_keys = ("total_sales", "gross_sales", "returns_total", "invoice_count", "return_count", "avg_invoice_value", "total_qty")
    cur_active = sum(1 for p in cur_pts if p["total"]) if granularity == "day" else rng.days
    prev_active = sum(1 for p in prev_pts if p["total"]) if granularity == "day" else prev.days
    cur_k = {**cur_k, "active_days": cur_active, "avg_per_day": round(cur_total / cur_active, 2) if cur_active else 0.0,
             "avg_qty_per_invoice": round(cur_k["total_qty"] / cur_k["invoice_count"], 2) if cur_k["invoice_count"] else 0.0}
    prev_k = {**prev_k, "active_days": prev_active, "avg_per_day": round(prev_total / prev_active, 2) if prev_active else 0.0,
              "avg_qty_per_invoice": round(prev_k["total_qty"] / prev_k["invoice_count"], 2) if prev_k["invoice_count"] else 0.0}
    deltas = {k: _pct(cur_k[k], prev_k[k]) for k in kpi_keys + ("active_days", "avg_per_day", "avg_qty_per_invoice")}
    return {
        "source": "sales_invoice", "range": rng.as_dict(), "previous_range": prev.as_dict(), "mode": mode,
        "granularity": granularity, "points": points,
        "current_total": round(cur_total, 2), "previous_total": round(prev_total, 2),
        "delta_pct": _pct(cur_total, prev_total), "delta_abs": round(cur_total - prev_total, 2),
        "current": cur_k, "previous": prev_k, "kpi_delta_pct": deltas,
    }


async def compare_breakdown(rng: DateRange, mode: str = "previous", cmp_start: date | None = None, cmp_end: date | None = None,
                            limit: int = 10) -> dict[str, Any]:
    """Item-group, item and weekday figures side by side for the two periods (what grew, what dropped)."""
    prev = comparison_range(rng, mode, cmp_start, cmp_end)
    cg, pg, ci, pi, cw, pw = await asyncio.gather(
        by_item_group(rng), by_item_group(prev), _item_frame(rng), _item_frame(prev), by_weekday(rng), by_weekday(prev),
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

    def _merge_items() -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        cols = ["item_code", "item_name", "item_group", "qty", "amount"]
        a = ci if not ci.empty else pd.DataFrame(columns=cols)
        b = pi if not pi.empty else pd.DataFrame(columns=cols)
        m = a.merge(b, on="item_code", how="outer", suffixes=("_c", "_p"))
        m["item_name"] = m["item_name_c"].fillna(m["item_name_p"]).fillna(m["item_code"])
        m["item_group"] = m["item_group_c"].fillna(m["item_group_p"])
        for col in ("qty_c", "qty_p", "amount_c", "amount_p"):
            m[col] = m[col].fillna(0.0).astype(float)
        m["delta_abs"] = m["amount_c"] - m["amount_p"]
        rows = [
            {"item_code": r.item_code, "label": r.item_name, "item_group": r.item_group if isinstance(r.item_group, str) else None,
             "current": round(r.amount_c, 2), "previous": round(r.amount_p, 2), "delta_abs": round(r.delta_abs, 2),
             "delta_pct": _pct(r.amount_c, r.amount_p), "current_qty": round(r.qty_c, 3), "previous_qty": round(r.qty_p, 3)}
            for r in m.itertuples()
        ]
        top = sorted(rows, key=lambda r: -r["current"])[:limit]
        gainers = [r for r in sorted(rows, key=lambda r: -r["delta_abs"]) if r["delta_abs"] > 0][:limit]
        losers = [r for r in sorted(rows, key=lambda r: r["delta_abs"]) if r["delta_abs"] < 0][:limit]
        return top, gainers, losers

    top, gainers, losers = _merge_items()
    weekdays = []
    for c, p in zip(cw["points"], pw["points"]):
        weekdays.append({"label": c["weekday"], "current": c["avg_per_day"], "previous": p["avg_per_day"],
                         "current_total": c["total"], "previous_total": p["total"], "delta_pct": _pct(c["avg_per_day"], p["avg_per_day"])})
    return {
        "source": "sales_invoice_item", "range": rng.as_dict(), "previous_range": prev.as_dict(), "mode": mode,
        "item_groups": _merge_groups(), "top_items": top, "gainers": gainers, "losers": losers, "weekdays": weekdays,
        "new_items": int(sum(1 for r in top if r["previous"] == 0)),
    }


async def by_item_group(rng: DateRange) -> dict[str, Any]:
    c = get_client()
    names = [r["name"] for r in await c.get_all("Sales Invoice", ["name"], _base_filters(rng))]
    empty = {"source": "sales_invoice_item", "range": rng.as_dict(), "groups": [], "total_amount": 0.0}
    if not names:
        return empty
    chunks = [names[i:i + 200] for i in range(0, len(names), 200)]
    results = await asyncio.gather(*[
        c.get_list(
            "Sales Invoice Item",
            ["item_group", "sum(qty) as qty", "sum(base_amount) as amount", "count(distinct item_code) as items"],
            [["parent", "in", chunk]], group_by="item_group", parent="Sales Invoice", limit_page_length=None,
        )
        for chunk in chunks
    ])
    df = pd.DataFrame([r for ch in results for r in ch], columns=["item_group", "qty", "amount", "items"])
    if df.empty:
        return empty
    df["item_group"] = df["item_group"].fillna("Ungrouped")
    df = df.groupby("item_group", as_index=False).agg(qty=("qty", "sum"), amount=("amount", "sum"), items=("items", "max"))
    df = df.sort_values("amount", ascending=False)
    total = float(df["amount"].sum())
    groups = [
        {"item_group": r.item_group, "qty": round(float(r.qty), 3), "amount": round(float(r.amount), 2),
         "items": int(r.items), "share_pct": round(float(r.amount) / total * 100, 1) if total else 0.0}
        for r in df.itertuples()
    ]
    return {**empty, "groups": groups, "total_amount": round(total, 2)}


async def by_hour(rng: DateRange) -> dict[str, Any]:
    df = await _invoice_frame(rng)
    sales_df = df[df["is_return"] == 0] if not df.empty else df
    active_days = int(sales_df["posting_date"].nunique()) if not sales_df.empty else 0
    points = []
    for h in range(24):
        sub = sales_df[sales_df["hour"] == h] if not sales_df.empty else sales_df
        total = float(sub["base_grand_total"].sum()) if not sub.empty else 0.0
        points.append({
            "hour": h, "label": f"{h:02d}:00", "total": round(total, 2), "invoice_count": int(len(sub)),
            "avg_per_day": round(total / active_days, 2) if active_days else 0.0,
        })
    peak = max(points, key=lambda p: p["total"]) if any(p["total"] for p in points) else None
    return {"source": "sales_invoice", "range": rng.as_dict(), "active_days": active_days,
            "points": points, "peak_hour": peak["hour"] if peak else None}


async def by_weekday(rng: DateRange) -> dict[str, Any]:
    df = await _invoice_frame(rng)
    sales_df = df[df["is_return"] == 0] if not df.empty else df
    days = pd.date_range(rng.start, rng.end, freq="D")
    occurrences = pd.Series(days.dayofweek).value_counts().to_dict()
    points = []
    for i, name in enumerate(WEEKDAYS):
        sub = sales_df[sales_df["posting_date"].dt.dayofweek == i] if not sales_df.empty else sales_df
        total = float(sub["base_grand_total"].sum()) if not sub.empty else 0.0
        occ = int(occurrences.get(i, 0))
        points.append({
            "weekday": name, "total": round(total, 2), "invoice_count": int(len(sub)), "occurrences": occ,
            "avg_per_day": round(total / occ, 2) if occ else 0.0,
        })
    best = max(points, key=lambda p: p["avg_per_day"]) if any(p["total"] for p in points) else None
    return {"source": "sales_invoice", "range": rng.as_dict(), "points": points,
            "best_weekday": best["weekday"] if best else None}


async def invoice_distribution(rng: DateRange) -> dict[str, Any]:
    df = await _invoice_frame(rng)
    sales_df = df[df["is_return"] == 0] if not df.empty else df
    vals = sales_df["base_grand_total"] if not sales_df.empty else pd.Series(dtype=float)
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
    return {"source": "sales_invoice", "range": rng.as_dict(), "buckets": buckets, "stats": stats}


async def top_customers(rng: DateRange, limit: int = 10) -> dict[str, Any]:
    rows = await get_client().get_list(
        "Sales Invoice",
        ["customer", "customer_name", "sum(base_grand_total) as total", "count(name) as invoice_count",
         "sum(outstanding_amount) as outstanding", "max(posting_date) as last_invoice"],
        _base_filters(rng), group_by="customer", order_by="total desc", limit_page_length=None,
    )
    grand = sum(float(r.get("total") or 0) for r in rows)
    customers = []
    for r in rows[:limit]:
        total = float(r.get("total") or 0)
        count = int(r.get("invoice_count") or 0)
        customers.append({
            "customer": r["customer"], "customer_name": r.get("customer_name") or r["customer"],
            "total": round(total, 2), "invoice_count": count,
            "avg_invoice_value": round(total / count, 2) if count else 0.0,
            "outstanding": round(float(r.get("outstanding") or 0), 2), "last_invoice": str(r.get("last_invoice") or ""),
            "share_pct": round(total / grand * 100, 1) if grand else 0.0,
        })
    return {"source": "sales_invoice", "range": rng.as_dict(), "customers": customers,
            "distinct_customers": len(rows), "total": round(grand, 2)}


async def payment_modes(rng: DateRange) -> dict[str, Any]:
    c = get_client()
    inv = await c.get_list(
        "Sales Invoice",
        ["name", "base_grand_total", "base_change_amount", "base_rounding_adjustment", "outstanding_amount", "is_pos"],
        _base_filters(rng) + [["is_return", "=", 0]], limit_page_length=None,
    )
    names = [r["name"] for r in inv]
    if not names:
        return {"source": "sales_invoice", "range": rng.as_dict(), "modes": [], "total": 0.0}
    chunks = [names[i:i + 200] for i in range(0, len(names), 200)]
    results = await asyncio.gather(*[
        c.get_list("Sales Invoice Payment", ["mode_of_payment", "sum(base_amount) as amount", "count(name) as n"],
                   [["parent", "in", chunk]], group_by="mode_of_payment", parent="Sales Invoice", limit_page_length=None)
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
    # POS change is handed back to the customer: net it off the largest mode (cash)
    if change and paid:
        biggest = max(paid, key=lambda k: paid[k]["amount"])
        paid[biggest]["amount"] -= change
    collected = sum(d["amount"] for d in paid.values())
    # payments settle the *rounded* total, so add the rounding back before looking for unpaid credit
    rounding = sum(float(r.get("base_rounding_adjustment") or 0) for r in inv)
    credit = max(0.0, grand + rounding - collected)
    if credit < 1.0:
        credit = 0.0
    modes = [{"mode": m, "amount": round(d["amount"], 2), "count": int(d["n"])} for m, d in paid.items()]
    if credit > 0.5:
        credit_count = sum(1 for r in inv if not r.get("is_pos") or float(r.get("outstanding_amount") or 0) > 0)
        modes.append({"mode": "Credit / Unpaid", "amount": round(credit, 2), "count": credit_count})
    modes.sort(key=lambda m: m["amount"], reverse=True)
    for m in modes:
        m["share_pct"] = round(m["amount"] / grand * 100, 1) if grand else 0.0
    return {"source": "sales_invoice", "range": rng.as_dict(), "modes": modes, "total": round(grand, 2)}


async def composition(rng: DateRange) -> dict[str, Any]:
    """Gross -> discounts -> taxes -> returns -> net sales (waterfall)."""
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
    returns = float(rr.get("total") or 0)  # already negative in ERPNext
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


# ------------------------------------------------------------ history, patterns, pace

def _month_start(d: date) -> date:
    return d.replace(day=1)


def _add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    return date(d.year + y, m + 1, 1)


async def monthly(rng: DateRange, months: int = 12) -> dict[str, Any]:
    """Net sales per calendar month for the `months` months ending in the month of `rng.end`,
    with month-over-month and year-over-year growth. Independent of `rng.start`."""
    end_month = _month_start(rng.end)
    first = _add_months(end_month, -(months + 12 - 1))  # extra year so YoY is available
    window = DateRange(first, rng.end)
    rows = await get_client().get_list(
        "Sales Invoice",
        ["posting_date", "sum(base_grand_total) as total", "count(name) as invoice_count", "sum(total_qty) as qty"],
        _base_filters(window), group_by="posting_date", order_by="posting_date asc", limit_page_length=None,
    )
    df = pd.DataFrame(rows, columns=["posting_date", "total", "invoice_count", "qty"])
    by_month: dict[str, dict[str, float]] = {}
    active_days: dict[str, int] = {}
    if not df.empty:
        df["posting_date"] = pd.to_datetime(df["posting_date"])
        df["month"] = df["posting_date"].dt.strftime("%Y-%m")
        for key, g in df.groupby("month"):
            by_month[str(key)] = {"total": float(g["total"].astype(float).sum()), "invoice_count": int(g["invoice_count"].sum()),
                                  "qty": float(g["qty"].astype(float).sum())}
            active_days[str(key)] = int((g["total"].astype(float) != 0).sum())
    today = date.today()
    points = []
    for i in range(months):
        m = _add_months(end_month, -(months - 1 - i))
        key = m.strftime("%Y-%m")
        prev_key = _add_months(m, -1).strftime("%Y-%m")
        ly_key = _add_months(m, -12).strftime("%Y-%m")
        cur = by_month.get(key, {"total": 0.0, "invoice_count": 0, "qty": 0.0})
        prev_total = by_month.get(prev_key, {}).get("total", 0.0)
        ly_total = by_month.get(ly_key, {}).get("total", 0.0)
        days_in_month = calendar.monthrange(m.year, m.month)[1]
        # the last month of the window is cut off at rng.end (or today), so its total is not a full month
        elapsed = min(rng.end, today).day if m == end_month else days_in_month
        is_partial = m == end_month and elapsed < days_in_month
        points.append({
            "period": m.isoformat(), "label": m.strftime("%b %y"), "total": round(cur["total"], 2),
            "invoice_count": cur["invoice_count"], "qty": round(cur["qty"], 3),
            "avg_invoice_value": round(cur["total"] / cur["invoice_count"], 2) if cur["invoice_count"] else 0.0,
            "active_days": active_days.get(key, 0), "avg_per_day": round(cur["total"] / elapsed, 2) if elapsed else 0.0,
            "mom_pct": _pct(cur["total"], prev_total), "last_year": round(ly_total, 2), "yoy_pct": _pct(cur["total"], ly_total),
            "is_partial": bool(is_partial),
        })
    non_zero = [p for p in points if p["total"]]
    best = max(non_zero, key=lambda p: p["total"]) if non_zero else None
    complete = [p for p in non_zero if not p["is_partial"]]
    return {
        "source": "sales_invoice", "range": window.as_dict(), "months": months, "points": points,
        "best_month": best["period"] if best else None,
        "avg_month": round(sum(p["total"] for p in complete) / len(complete), 2) if complete else 0.0,
        "total": round(sum(p["total"] for p in points), 2),
    }


async def heatmap(rng: DateRange) -> dict[str, Any]:
    """Average sales per weekday x hour cell (total / number of that weekday in range)."""
    df = await _invoice_frame(rng)
    sales_df = df[df["is_return"] == 0] if not df.empty else df
    days = pd.date_range(rng.start, rng.end, freq="D")
    occurrences = pd.Series(days.dayofweek).value_counts().to_dict()
    grouped: dict[tuple[int, int], dict[str, float]] = {}
    if not sales_df.empty:
        sub = sales_df.dropna(subset=["hour"])
        for (wd, h), g in sub.groupby([sub["posting_date"].dt.dayofweek, sub["hour"].astype(int)]):
            grouped[(int(wd), int(h))] = {"total": float(g["base_grand_total"].sum()), "n": int(len(g))}
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
        "source": "sales_invoice", "range": rng.as_dict(), "weekdays": WEEKDAYS, "cells": cells, "max_avg": round(max_avg, 2),
        "hour_min": min(hours_with_sales) if hours_with_sales else 0, "hour_max": max(hours_with_sales) if hours_with_sales else 23,
        "peak": {"weekday": peak["weekday"], "hour": peak["hour"], "avg_per_day": peak["avg_per_day"]} if peak else None,
    }


async def item_pareto(rng: DateRange, limit: int = 30) -> dict[str, Any]:
    """ABC / Pareto analysis: which items make up 80% (A), the next 15% (B) and the last 5% (C) of sales."""
    df = await _item_frame(rng)
    empty = {"source": "sales_invoice_item", "range": rng.as_dict(), "items": [], "classes": [], "distinct_items": 0,
             "total_amount": 0.0, "items_for_80_pct": 0}
    if df.empty:
        return empty
    df = df[df["amount"] > 0].reset_index(drop=True)
    if df.empty:
        return empty
    total = float(df["amount"].sum())
    df["share_pct"] = df["amount"] / total * 100
    df["cum_share_pct"] = df["share_pct"].cumsum()
    # an item belongs to A while the running total *before* it is under 80% (so the item crossing the line is still A)
    before = df["cum_share_pct"] - df["share_pct"]
    df["cls"] = ["A" if b < 80 else "B" if b < 95 else "C" for b in before]
    classes = []
    for k in ("A", "B", "C"):
        sub = df[df["cls"] == k]
        classes.append({"cls": k, "items": int(len(sub)), "amount": round(float(sub["amount"].sum()), 2),
                        "share_pct": round(float(sub["share_pct"].sum()), 1),
                        "items_pct": round(len(sub) / len(df) * 100, 1)})
    items = [
        {"rank": i + 1, "item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group if isinstance(r.item_group, str) else None,
         "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3), "share_pct": round(float(r.share_pct), 2),
         "cum_share_pct": round(float(r.cum_share_pct), 1), "cls": r.cls}
        for i, r in enumerate(df.head(limit).itertuples())
    ]
    return {**empty, "items": items, "classes": classes, "distinct_items": int(len(df)), "total_amount": round(total, 2),
            "items_for_80_pct": int((df["cls"] == "A").sum())}


async def run_rate(rng: DateRange) -> dict[str, Any]:
    """Daily pace for the range plus a straight-line projection for the month containing `rng.end`."""
    _, points = await _trend_points(rng, "day")
    active = [p for p in points if p["total"]]
    total = sum(p["total"] for p in points)
    best = max(active, key=lambda p: p["total"]) if active else None
    worst = min(active, key=lambda p: p["total"]) if active else None
    month_start = _month_start(rng.end)
    days_in_month = calendar.monthrange(rng.end.year, rng.end.month)[1]
    month_end = date(rng.end.year, rng.end.month, days_in_month)
    mtd_rng = DateRange(month_start, rng.end)
    if rng.start <= month_start:
        mpts = [p for p in points if p["period"] >= month_start.isoformat()]
    else:
        _, mpts = await _trend_points(mtd_rng, "day")
    mtd = sum(p["total"] for p in mpts)
    mtd_active = sum(1 for p in mpts if p["total"])
    elapsed = mtd_rng.days
    remaining = days_in_month - elapsed
    projected = mtd / elapsed * days_in_month if elapsed else 0.0
    today = date.today()
    return {
        "source": "sales_invoice", "range": rng.as_dict(),
        "total": round(total, 2), "calendar_days": rng.days, "active_days": len(active),
        "avg_per_day": round(total / rng.days, 2) if rng.days else 0.0,
        "avg_per_active_day": round(total / len(active), 2) if active else 0.0,
        "best_day": {"date": best["period"], "total": best["total"], "invoice_count": best["invoice_count"]} if best else None,
        "worst_day": {"date": worst["period"], "total": worst["total"], "invoice_count": worst["invoice_count"]} if worst else None,
        "month": {
            "start": month_start.isoformat(), "end": month_end.isoformat(), "label": month_start.strftime("%B %Y"),
            "days_in_month": days_in_month, "elapsed_days": elapsed, "remaining_days": remaining, "active_days": mtd_active,
            "mtd": round(mtd, 2), "avg_per_day": round(mtd / elapsed, 2) if elapsed else 0.0,
            "projected": round(projected, 2), "is_current": month_start == _month_start(today),
            "is_complete": remaining == 0,
        },
    }
