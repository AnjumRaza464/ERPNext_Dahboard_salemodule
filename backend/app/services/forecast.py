"""Production forecast.

`next_day_plan` answers "kal kitna banana hai": for the plan date (default tomorrow) it takes the same
weekday in each of the last N weeks, looks up what sold on those days (bills, in stock units), and
suggests the average as the quantity to make. Days with no bills at all (closed, or not yet keyed in)
and the bulk-entry days are left out of the average; a day that traded but sold none of an item counts
as zero. The producing department comes from the production (Repack) entries of the same weeks.
"""
from __future__ import annotations

import asyncio
import math
from datetime import date, timedelta
from typing import Any

import pandas as pd

from ..cache import cached
from ..config import get_settings
from ..dates import DateRange, today_local
from ..erpnext_client import get_client
from . import costing, live, sales

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
ITEM_CHUNK = 200


async def _sold_by_day(rng: DateRange) -> pd.DataFrame:
    """One row per bill date x item: qty sold in stock units and net amount (returns excluded)."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        out: list[dict[str, Any]] = []
        for parent_dt, child_dt, extra in sales.ITEM_SOURCES:
            parents = await c.get_all(parent_dt, ["name", "posting_date"], live._filters(rng, extra + [["is_return", "=", 0]]))
            dates = {p["name"]: str(p["posting_date"]) for p in parents}
            names = list(dates)
            if not names:
                continue
            results = await asyncio.gather(*[
                c.get_list(child_dt, ["parent", "item_code", "item_name", "item_group", "stock_uom", "sum(stock_qty) as qty", "sum(base_net_amount) as amount"],
                           [["parent", "in", names[i:i + ITEM_CHUNK]]], group_by="parent, item_code", parent=parent_dt, limit_page_length=None)
                for i in range(0, len(names), ITEM_CHUNK)
            ])
            for chunk in results:
                for r in chunk:
                    out.append({"date": dates.get(r["parent"]), "item_code": r["item_code"], "item_name": r.get("item_name") or r["item_code"],
                                "item_group": r.get("item_group") or "Ungrouped", "uom": r.get("stock_uom") or "",
                                "qty": float(r.get("qty") or 0), "amount": float(r.get("amount") or 0)})
        return out

    rows, _ = await cached(f"forecast:sold:{rng.key()}", _load, refresh=rng.end >= today_local())
    df = pd.DataFrame(rows, columns=["date", "item_code", "item_name", "item_group", "uom", "qty", "amount"])
    if df.empty:
        return df
    return df.groupby(["date", "item_code"], as_index=False).agg(
        item_name=("item_name", "first"), item_group=("item_group", "first"), uom=("uom", "first"), qty=("qty", "sum"), amount=("amount", "sum"))


async def next_day_plan(plan_date: date | None = None, weeks: int = 4, refresh: bool = False, max_weeks: int = 12, source: str = "sales") -> dict[str, Any]:
    """`source` = "sales" plans on what sold on past same weekdays (bills); "production" on what was produced
    on them (Repack entries), so the plan repeats what the bakery actually made."""
    plan = plan_date or (today_local() + timedelta(days=1))
    weekday = WEEKDAYS[plan.weekday()]
    excluded = get_settings().excluded_dates
    # look back far enough to find `weeks` same-weekday trading days (bills are keyed in batches, so many
    # calendar days have none); the window also feeds the fallback and the department mapping
    window = DateRange(plan - timedelta(days=7 * max_weeks), plan - timedelta(days=1))
    sold, se = await asyncio.gather(_sold_by_day(window), costing._production_frame(window, refresh))
    if source == "production":
        made = se[se["kind"] == "produced"] if not se.empty else se
        sold = made.assign(date=made["date"].dt.strftime("%Y-%m-%d")).groupby(["date", "item_code"], as_index=False).agg(
            item_name=("item_name", "first"), item_group=("item_group", "first"), uom=("uom", "first"), qty=("qty", "sum"), amount=("amount", "sum"),
        ) if not made.empty else sold.iloc[0:0]
    no_data = "no production entry" if source == "production" else "no bills"

    traded = sorted(set(sold["date"].unique()) - excluded) if not sold.empty else []
    same_weekday = [d for d in traded if date.fromisoformat(d).weekday() == plan.weekday()]
    used_iso = sorted(same_weekday, reverse=True)[:weeks]
    basis = "same_weekday"
    if not used_iso:
        # no past Thursday (say) with bills at all: fall back to the most recent trading days
        used_iso = sorted(traded, reverse=True)[:weeks]
        basis = "recent_days"
    candidates = [plan - timedelta(days=7 * k) for k in range(1, weeks + 1)]
    skipped = [{"date": d.isoformat(), "reason": "bulk-entry day" if d.isoformat() in excluded else no_data} for d in candidates if d.isoformat() not in used_iso]
    n = len(used_iso)

    # which department makes each product (most recent production entry wins)
    dept_of: dict[str, str] = {}
    if not se.empty:
        consumed = se[se["kind"] == "consumed"]
        produced = se[se["kind"] == "produced"]
        if not consumed.empty and not produced.empty:
            owner = consumed.assign(dept=consumed["warehouse"].map(costing.dept_label)).groupby("parent")["dept"].first()
            p = produced.assign(dept=produced["parent"].map(owner)).dropna(subset=["dept"]).sort_values("date")
            dept_of = {str(k): str(v) for k, v in p.groupby("item_code")["dept"].last().items()}

    empty = {"source": "stock_entry" if source == "production" else "pos_invoice_item", "plan_on": source, "plan_date": plan.isoformat(), "weekday": weekday, "weeks": weeks, "basis": basis,
             "lookback_weeks": max_weeks, "dates_used": used_iso, "dates_skipped": skipped, "items": [], "totals": {"suggested_qty": 0, "avg_sales": 0.0, "products": 0, "last_week_qty": 0.0, "last_week_sales": 0.0},
             "by_department": []}
    if n == 0 or sold.empty:
        return empty

    sub = sold[sold["date"].isin(used_iso)]
    meta = sub.groupby("item_code").agg(item_name=("item_name", "first"), item_group=("item_group", "first"), uom=("uom", "first"))
    qty_pivot = sub.pivot_table(index="item_code", columns="date", values="qty", aggfunc="sum", fill_value=0.0).reindex(columns=used_iso, fill_value=0.0)
    amt_pivot = sub.pivot_table(index="item_code", columns="date", values="amount", aggfunc="sum", fill_value=0.0).reindex(columns=used_iso, fill_value=0.0)
    last = used_iso[0]  # most recent same weekday

    items = []
    for code, m in meta.iterrows():
        q = qty_pivot.loc[code]
        a = amt_pivot.loc[code]
        avg = float(q.sum()) / n
        avg_amt = float(a.sum()) / n
        vals = [float(q[d]) for d in used_iso]
        # trend: the two most recent weeks against the two before (needs 4 weeks)
        trend = None
        if n >= 4:
            recent, older = sum(vals[:2]) / 2, sum(vals[2:4]) / 2
            trend = round((recent - older) / older * 100, 1) if older else None
        items.append({
            "item_code": code, "item_name": m["item_name"], "item_group": m["item_group"], "uom": m["uom"],
            "department": dept_of.get(code, "Bought in"),
            "by_date": {d: round(float(q[d]), 3) for d in used_iso},
            "avg_qty": round(avg, 2), "suggested_qty": int(math.ceil(avg - 1e-9)),
            "last_week_qty": round(float(q[last]), 3), "max_qty": round(float(q.max()), 3), "min_qty": round(float(q.min()), 3),
            "days_sold": int((q > 0).sum()), "avg_sales": round(avg_amt, 2),
            "avg_price": round(float(a.sum()) / float(q.sum()), 2) if q.sum() else 0.0,
            "trend_pct": trend,
        })
    items.sort(key=lambda x: -x["avg_sales"])

    df = pd.DataFrame(items)
    by_dept = [
        {"department": k, "suggested_qty": int(v["suggested_qty"]), "avg_sales": round(float(v["avg_sales"]), 2), "products": int(v["item_code"])}
        for k, v in df.groupby("department").agg(suggested_qty=("suggested_qty", "sum"), avg_sales=("avg_sales", "sum"), item_code=("item_code", "nunique")).sort_values("avg_sales", ascending=False).iterrows()
    ]
    return {
        **empty, "items": items, "by_department": by_dept,
        "totals": {
            "suggested_qty": int(df["suggested_qty"].sum()), "avg_sales": round(float(df["avg_sales"].sum()), 2), "products": int(len(df)),
            "last_week_qty": round(float(df["last_week_qty"].sum()), 3), "last_week_sales": round(float(amt_pivot[last].sum()), 2),
        },
    }
