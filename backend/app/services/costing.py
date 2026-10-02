"""Costing figures for the dashboard: raw material purchases, consumption and stock.

How material moves on this instance (see README):

* **Purchase Invoice** (update_stock) brings raw material, packaging and bought-in finished
  goods into *Stores* (bought-in finished goods go straight to *Finished Goods*).
* **Stock Entry / Material Transfer** moves raw material from Stores into the production
  departments (Bread, Dry, Icing).
* **Stock Entry / Repack** is the production step: raw material and packaging are consumed
  out of a department and finished goods are booked into *Finished Goods*. (Manufacture /
  Material Issue entries, if ever used, are treated the same way.)
* Finished goods are transferred to the outlet and sold through the POS.

Three cached frames feed every endpoint:

* `_purchase_frame(rng)`   - one row per purchase invoice x item (date, supplier, group, qty, amount)
* `_production_frame(rng)` - one row per production entry x item x warehouse, `kind` = consumed / produced
* `_stock_frame()`         - current stock per item x warehouse (Bin), joined with the item master

Amounts are ERPNext valuation amounts in PKR (Stock Entry Detail `amount`, Purchase Invoice
Item `base_net_amount`). Quantities are in the item's stock UOM.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pandas as pd

from ..cache import cached
from ..dates import DateRange, today_local
from ..erpnext_client import get_client
from . import sales
from .sales import outlet_label

ITEM_CHUNK = 200
RAW = "Raw Material"
PACKAGING = "Packaging"
PRODUCTION_PURPOSES = ["Repack", "Manufacture", "Material Issue"]

PI_COLS = ["parent", "date", "supplier", "item_code", "item_name", "item_group", "uom", "qty", "amount"]
SE_COLS = ["parent", "date", "purpose", "kind", "warehouse", "item_code", "item_name", "item_group", "uom", "qty", "amount"]
STOCK_COLS = ["item_code", "item_name", "item_group", "warehouse", "qty", "uom", "value", "valuation_rate"]
ITEM_COLS = ["item_code", "item_name", "item_group", "uom", "qty", "amount", "entries", "rate"]


def _filters(rng: DateRange, extra: list[list[Any]] | None = None) -> list[list[Any]]:
    f: list[list[Any]] = [
        ["docstatus", "=", 1], ["company", "=", get_client().company],
        ["posting_date", ">=", rng.start.isoformat()], ["posting_date", "<=", rng.end.isoformat()],
    ]
    return f + list(extra or [])


def _refresh_ok(rng: DateRange, refresh: bool) -> bool:
    return refresh and rng.end >= today_local()


def _pct(cur: float, prev: float | None) -> float | None:
    return round((cur - prev) / abs(prev) * 100, 1) if prev else None


def _num(df: pd.DataFrame, cols: tuple[str, ...]) -> pd.DataFrame:
    for col in cols:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0).astype(float)
    return df


def _chunks(names: list[str]) -> list[list[str]]:
    return [names[i:i + ITEM_CHUNK] for i in range(0, len(names), ITEM_CHUNK)]


def _sum(df: pd.DataFrame, col: str) -> float:
    return float(df[col].sum()) if not df.empty else 0.0


def _nunique(df: pd.DataFrame, col: str) -> int:
    return int(df[col].nunique()) if not df.empty else 0


# ------------------------------------------------------------------ frames

async def _purchase_frame(rng: DateRange, refresh: bool = False) -> pd.DataFrame:
    """Purchase Invoice lines in the range (returns come through as negative qty / amount)."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        heads = await c.get_all("Purchase Invoice", ["name", "posting_date", "supplier_name"], _filters(rng))
        if not heads:
            return []
        meta = {h["name"]: h for h in heads}
        results = await asyncio.gather(*[
            c.get_list(
                "Purchase Invoice Item",
                ["parent", "item_code", "item_name", "item_group", "stock_uom", "sum(stock_qty) as qty", "sum(base_net_amount) as amount"],
                [["parent", "in", chunk]], group_by="parent, item_code", parent="Purchase Invoice", limit_page_length=None,
            )
            for chunk in _chunks(list(meta))
        ])
        out: list[dict[str, Any]] = []
        for chunk in results:
            for r in chunk:
                h = meta.get(r["parent"]) or {}
                out.append({
                    "parent": r["parent"], "date": h.get("posting_date"), "supplier": h.get("supplier_name") or "Unknown",
                    "item_code": r["item_code"], "item_name": r.get("item_name") or r["item_code"],
                    "item_group": r.get("item_group") or "Ungrouped", "uom": r.get("stock_uom") or "",
                    "qty": r.get("qty") or 0, "amount": r.get("amount") or 0,
                })
        return out

    rows, _ = await cached(f"costing:pi:{rng.key()}", _load, refresh=_refresh_ok(rng, refresh))
    df = pd.DataFrame(rows, columns=PI_COLS)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    return _num(df, ("qty", "amount"))


async def _production_frame(rng: DateRange, refresh: bool = False) -> pd.DataFrame:
    """Production Stock Entries (Repack / Manufacture / Material Issue) split into consumed and produced lines."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        heads = await c.get_all("Stock Entry", ["name", "posting_date", "purpose"], _filters(rng, [["purpose", "in", PRODUCTION_PURPOSES]]))
        if not heads:
            return []
        meta = {h["name"]: h for h in heads}
        results = await asyncio.gather(*[
            c.get_list(
                "Stock Entry Detail",
                ["parent", "item_code", "item_name", "item_group", "stock_uom", "s_warehouse", "t_warehouse",
                 "sum(transfer_qty) as qty", "sum(amount) as amount"],
                [["parent", "in", chunk]], group_by="parent, item_code, s_warehouse, t_warehouse", parent="Stock Entry", limit_page_length=None,
            )
            for chunk in _chunks(list(meta))
        ])
        out: list[dict[str, Any]] = []
        for chunk in results:
            for r in chunk:
                h = meta.get(r["parent"]) or {}
                consumed = bool(r.get("s_warehouse"))
                out.append({
                    "parent": r["parent"], "date": h.get("posting_date"), "purpose": h.get("purpose"),
                    "kind": "consumed" if consumed else "produced",
                    "warehouse": (r.get("s_warehouse") if consumed else r.get("t_warehouse")) or "",
                    "item_code": r["item_code"], "item_name": r.get("item_name") or r["item_code"],
                    "item_group": r.get("item_group") or "Ungrouped", "uom": r.get("stock_uom") or "",
                    "qty": r.get("qty") or 0, "amount": r.get("amount") or 0,
                })
        return out

    rows, _ = await cached(f"costing:se:{rng.key()}", _load, refresh=_refresh_ok(rng, refresh))
    df = pd.DataFrame(rows, columns=SE_COLS)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    return _num(df, ("qty", "amount"))


async def _stock_frame(refresh: bool = False) -> pd.DataFrame:
    """Current stock per item x warehouse for the company's warehouses, with item group and name."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        warehouses, bins, items = await asyncio.gather(
            c.get_all("Warehouse", ["name"], [["company", "=", c.company], ["is_group", "=", 0]]),
            c.get_all("Bin", ["item_code", "warehouse", "actual_qty", "stock_value", "valuation_rate", "stock_uom"], [["actual_qty", "!=", 0]], page_size=2000),
            c.get_all("Item", ["name", "item_name", "item_group"], [["is_stock_item", "=", 1]], page_size=2000),
        )
        own = {w["name"] for w in warehouses}
        imap = {i["name"]: i for i in items}
        out: list[dict[str, Any]] = []
        for b in bins:
            if own and b["warehouse"] not in own:
                continue
            it = imap.get(b["item_code"], {})
            out.append({
                "item_code": b["item_code"], "item_name": it.get("item_name") or b["item_code"], "item_group": it.get("item_group") or "Ungrouped",
                "warehouse": b["warehouse"], "qty": b.get("actual_qty") or 0, "uom": b.get("stock_uom") or "",
                "value": b.get("stock_value") or 0, "valuation_rate": b.get("valuation_rate") or 0,
            })
        return out

    rows, _ = await cached("costing:stock", _load, refresh=refresh)
    df = pd.DataFrame(rows, columns=STOCK_COLS)
    if df.empty:
        return df
    return _num(df, ("qty", "value", "valuation_rate"))


async def _net_sales(rng: DateRange, refresh: bool = False) -> float:
    daily = sales._daily(await sales._check_days(rng, refresh), rng)
    return float(daily["net"].sum()) if not daily.empty else 0.0


async def _latest_dates() -> dict[str, str | None]:
    """Most recent purchase invoice and production entry on record (data-freshness line)."""

    async def _load() -> dict[str, str | None]:
        c = get_client()
        base = [["docstatus", "=", 1], ["company", "=", c.company]]
        pi, se = await asyncio.gather(
            c.get_list("Purchase Invoice", ["posting_date"], base, order_by="posting_date desc", limit_page_length=1),
            c.get_list("Stock Entry", ["posting_date"], base + [["purpose", "in", PRODUCTION_PURPOSES]], order_by="posting_date desc", limit_page_length=1),
        )
        return {"last_purchase_date": pi[0]["posting_date"] if pi else None, "last_production_date": se[0]["posting_date"] if se else None}

    value, _ = await cached("costing:latest", _load)
    return value


# ------------------------------------------------------------------ totals

def _totals(pi: pd.DataFrame, se: pd.DataFrame, rng: DateRange, net_sales: float) -> dict[str, Any]:
    raw_pi = pi[pi["item_group"] == RAW] if not pi.empty else pi
    consumed = se[se["kind"] == "consumed"] if not se.empty else se
    produced = se[se["kind"] == "produced"] if not se.empty else se
    raw_consumed = consumed[consumed["item_group"] == RAW] if not consumed.empty else consumed
    pack_consumed = consumed[consumed["item_group"] == PACKAGING] if not consumed.empty else consumed

    raw_purchases = _sum(raw_pi, "amount")
    consumed_total = _sum(consumed, "amount")
    raw_consumed_total = _sum(raw_consumed, "amount")
    produced_value = _sum(produced, "amount")
    production_days = int(se["date"].dt.normalize().nunique()) if not se.empty else 0

    return {
        "net_sales": round(net_sales, 2),
        "raw_purchases": round(raw_purchases, 2),
        "raw_purchase_qty": round(_sum(raw_pi, "qty"), 3),
        "raw_purchase_items": _nunique(raw_pi, "item_code"),
        "purchases_total": round(_sum(pi, "amount"), 2),
        "purchase_invoices": _nunique(pi, "parent"),
        "purchase_days": int(pi["date"].dt.normalize().nunique()) if not pi.empty else 0,
        "consumed": round(consumed_total, 2),
        "raw_consumed": round(raw_consumed_total, 2),
        "packaging_consumed": round(_sum(pack_consumed, "amount"), 2),
        "consumed_qty": round(_sum(consumed, "qty"), 3),
        "consumed_items": _nunique(consumed, "item_code"),
        "batches": _nunique(se, "parent"),
        "production_days": production_days,
        "produced_value": round(produced_value, 2),
        "produced_qty": round(_sum(produced, "qty"), 3),
        "produced_items": _nunique(produced, "item_code"),
        # material consumed as a share of net sales (the material-cost ratio)
        "material_cost_pct": round(consumed_total / net_sales * 100, 1) if net_sales else None,
        "raw_purchases_pct_of_sales": round(raw_purchases / net_sales * 100, 1) if net_sales else None,
        # value booked into finished goods per PKR 100 of material consumed
        "yield_pct": round(produced_value / consumed_total * 100, 1) if consumed_total else None,
        "avg_consumed_per_production_day": round(consumed_total / production_days, 2) if production_days else 0.0,
        "avg_consumed_per_day": round(consumed_total / rng.days, 2) if rng.days else 0.0,
        # raw material bought minus raw material used: positive = stock built up
        "purchase_gap": round(raw_purchases - raw_consumed_total, 2),
        "calendar_days": rng.days,
    }


DELTA_KEYS = ("net_sales", "raw_purchases", "raw_purchase_qty", "purchases_total", "purchase_invoices", "consumed", "raw_consumed",
              "packaging_consumed", "consumed_qty", "batches", "production_days", "produced_value", "produced_qty",
              "avg_consumed_per_production_day", "avg_consumed_per_day", "purchase_gap")
POINT_KEYS = ("material_cost_pct", "yield_pct", "raw_purchases_pct_of_sales")


async def kpis(rng: DateRange, refresh: bool = False) -> dict[str, Any]:
    prev = rng.previous()
    pi, pi_prev, se, se_prev, net, net_prev, stock_df, latest = await asyncio.gather(
        _purchase_frame(rng, refresh), _purchase_frame(prev), _production_frame(rng, refresh), _production_frame(prev),
        _net_sales(rng, refresh), _net_sales(prev), _stock_frame(refresh), _latest_dates(),
    )
    cur_t = _totals(pi, se, rng, net)
    prev_t = _totals(pi_prev, se_prev, prev, net_prev)
    delta = {k: _pct(float(cur_t[k]), float(prev_t[k])) for k in DELTA_KEYS}
    # ratios compare in percentage points, not percent of percent
    delta_points = {
        k: (round(cur_t[k] - prev_t[k], 1) if cur_t[k] is not None and prev_t[k] is not None else None) for k in POINT_KEYS
    }

    raw_stock = stock_df[stock_df["item_group"] == RAW] if not stock_df.empty else stock_df
    pack_stock = stock_df[stock_df["item_group"] == PACKAGING] if not stock_df.empty else stock_df
    raw_value = _sum(raw_stock, "value")
    daily_raw_use = cur_t["raw_consumed"] / rng.days if rng.days else 0.0
    by_wh = []
    if not raw_stock.empty:
        g = raw_stock.groupby("warehouse", as_index=False).agg(value=("value", "sum"), items=("item_code", "nunique")).sort_values("value", ascending=False)
        by_wh = [{"warehouse": outlet_label(r.warehouse), "value": round(float(r.value), 2), "items": int(r.items)} for r in g.itertuples()]

    return {
        "source": "stock_entry",
        "range": rng.as_dict(),
        "previous_range": prev.as_dict(),
        "current": cur_t,
        "previous": prev_t,
        "delta_pct": delta,
        "delta_points": delta_points,
        "stock": {
            "raw_value": round(raw_value, 2),
            "raw_items": _nunique(raw_stock, "item_code"),
            "packaging_value": round(_sum(pack_stock, "value"), 2),
            "total_value": round(_sum(stock_df, "value"), 2),
            # at this range's average daily raw-material usage, how many days the raw stock lasts
            "raw_days_cover": round(raw_value / daily_raw_use, 1) if daily_raw_use > 0 else None,
            "by_warehouse": by_wh,
        },
        "health": {**latest, "today": today_local().isoformat()},
    }


# ------------------------------------------------------------------ trend

async def trend(rng: DateRange, refresh: bool = False) -> dict[str, Any]:
    pi, se = await asyncio.gather(_purchase_frame(rng, refresh), _production_frame(rng, refresh))
    days = pd.date_range(rng.start, rng.end, freq="D")

    def _series(df: pd.DataFrame, mask: pd.Series | None) -> pd.Series:
        if df.empty:
            return pd.Series(0.0, index=days)
        d = df if mask is None else df[mask]
        s = d.groupby(d["date"].dt.normalize())["amount"].sum()
        return s.reindex(days, fill_value=0.0)

    out = pd.DataFrame({"date": days})
    out["purchased"] = _series(pi, pi["item_group"] == RAW if not pi.empty else None).values
    out["purchased_all"] = _series(pi, None).values
    out["consumed"] = _series(se, se["kind"] == "consumed" if not se.empty else None).values
    out["produced"] = _series(se, se["kind"] == "produced" if not se.empty else None).values
    if se.empty:
        out["batches"] = 0
    else:
        b = se.groupby(se["date"].dt.normalize())["parent"].nunique()
        out["batches"] = b.reindex(days, fill_value=0).values

    if rng.granularity == "month":
        g = out.groupby(out["date"].dt.to_period("M")).agg(
            purchased=("purchased", "sum"), purchased_all=("purchased_all", "sum"), consumed=("consumed", "sum"),
            produced=("produced", "sum"), batches=("batches", "sum"),
        ).reset_index()
        g["date"] = g["date"].dt.to_timestamp()
        out = g
    points = [
        {"period": r.date.strftime("%Y-%m-%d"), "purchased": round(float(r.purchased), 2), "purchased_all": round(float(r.purchased_all), 2),
         "consumed": round(float(r.consumed), 2), "produced": round(float(r.produced), 2), "batches": int(r.batches)}
        for r in out.itertuples()
    ]
    return {
        "source": "stock_entry", "range": rng.as_dict(), "granularity": rng.granularity, "points": points,
        "totals": {k: round(float(out[k].sum()), 2) for k in ("purchased", "purchased_all", "consumed", "produced")},
    }


# ------------------------------------------------------------------ consumption

def _group_items(df: pd.DataFrame) -> pd.DataFrame:
    """One row per item: name, group, uom, qty, amount, distinct documents, average rate (amount / qty)."""
    if df.empty:
        return pd.DataFrame(columns=ITEM_COLS)
    g = df.groupby("item_code", as_index=False).agg(
        item_name=("item_name", "first"), item_group=("item_group", "first"), uom=("uom", "first"),
        qty=("qty", "sum"), amount=("amount", "sum"), entries=("parent", "nunique"),
    )
    g["rate"] = [a / q if q else 0.0 for a, q in zip(g["amount"], g["qty"])]
    return g.sort_values("amount", ascending=False).reset_index(drop=True)


def _head(df: pd.DataFrame, limit: int) -> pd.DataFrame:
    """First `limit` rows, or every row when limit is 0."""
    return df if limit <= 0 else df.head(limit)


def _share(value: float, total: float) -> float:
    return round(value / total * 100, 1) if total else 0.0


async def consumption(rng: DateRange, limit: int = 15, refresh: bool = False) -> dict[str, Any]:
    prev = rng.previous()
    se, se_prev = await asyncio.gather(_production_frame(rng, refresh), _production_frame(prev))
    empty = {"source": "stock_entry", "range": rng.as_dict(), "previous_range": prev.as_dict(), "total": 0.0, "distinct_items": 0,
             "by_department": [], "by_group": [], "items": [], "other_amount": 0.0,
             "produced": [], "produced_total": 0.0, "produced_other": 0.0, "produced_distinct_items": 0}
    if se.empty:
        return empty
    consumed = se[se["kind"] == "consumed"]
    produced = se[se["kind"] == "produced"]
    total = _sum(consumed, "amount")

    dep = consumed.groupby("warehouse", as_index=False).agg(amount=("amount", "sum"), entries=("parent", "nunique"), items=("item_code", "nunique"))
    by_department = [
        {"department": outlet_label(r.warehouse), "amount": round(float(r.amount), 2), "entries": int(r.entries), "items": int(r.items),
         "share_pct": _share(float(r.amount), total)}
        for r in dep.sort_values("amount", ascending=False).itertuples()
    ]
    grp = consumed.groupby("item_group", as_index=False).agg(amount=("amount", "sum"), qty=("qty", "sum"), items=("item_code", "nunique"))
    by_group = [
        {"item_group": r.item_group, "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3), "items": int(r.items),
         "share_pct": _share(float(r.amount), total)}
        for r in grp.sort_values("amount", ascending=False).itertuples()
    ]

    cur_items = _group_items(consumed)
    prev_items = _group_items(se_prev[se_prev["kind"] == "consumed"]) if not se_prev.empty else _group_items(se_prev)
    prev_map = {r.item_code: (float(r.amount), float(r.rate)) for r in prev_items.itertuples()}
    head = _head(cur_items, limit)
    items = []
    for r in head.itertuples():
        p_amt, p_rate = prev_map.get(r.item_code, (0.0, 0.0))
        items.append({
            "item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group, "uom": r.uom,
            "qty": round(float(r.qty), 3), "amount": round(float(r.amount), 2), "rate": round(float(r.rate), 2),
            "entries": int(r.entries), "share_pct": _share(float(r.amount), total),
            "prev_amount": round(p_amt, 2), "delta_pct": _pct(float(r.amount), p_amt),
            "prev_rate": round(p_rate, 2) if p_rate else None, "rate_change_pct": _pct(float(r.rate), p_rate) if p_rate else None,
        })

    prod = _group_items(produced)
    produced_total = _sum(produced, "amount")
    prod_head = _head(prod, limit)
    produced_items = [
        {"item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group, "uom": r.uom, "qty": round(float(r.qty), 3),
         "amount": round(float(r.amount), 2), "rate": round(float(r.rate), 2), "entries": int(r.entries),
         "share_pct": _share(float(r.amount), produced_total)}
        for r in prod_head.itertuples()
    ]
    return {
        **empty, "total": round(total, 2), "distinct_items": _nunique(cur_items, "item_code"),
        "by_department": by_department, "by_group": by_group, "items": items,
        "other_amount": round(total - _sum(head, "amount"), 2),
        "produced": produced_items, "produced_total": round(produced_total, 2),
        "produced_other": round(produced_total - _sum(prod_head, "amount"), 2),
        "produced_distinct_items": _nunique(prod, "item_code"),
    }


# ------------------------------------------------------------------ purchases

async def purchases(rng: DateRange, limit: int = 15, refresh: bool = False) -> dict[str, Any]:
    prev = rng.previous()
    pi, pi_prev = await asyncio.gather(_purchase_frame(rng, refresh), _purchase_frame(prev))
    empty = {"source": "purchase_invoice", "range": rng.as_dict(), "previous_range": prev.as_dict(), "total": 0.0, "raw_total": 0.0,
             "invoices": 0, "distinct_items": 0, "by_supplier": [], "by_group": [], "items": [], "other_amount": 0.0}
    if pi.empty:
        return empty
    total = _sum(pi, "amount")
    sup = pi.groupby("supplier", as_index=False).agg(amount=("amount", "sum"), invoices=("parent", "nunique"), items=("item_code", "nunique"))
    by_supplier = [
        {"supplier": r.supplier.strip(), "amount": round(float(r.amount), 2), "invoices": int(r.invoices), "items": int(r.items),
         "share_pct": _share(float(r.amount), total)}
        for r in sup.sort_values("amount", ascending=False).itertuples()
    ]
    grp = pi.groupby("item_group", as_index=False).agg(amount=("amount", "sum"), qty=("qty", "sum"), items=("item_code", "nunique"))
    by_group = [
        {"item_group": r.item_group, "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3), "items": int(r.items),
         "share_pct": _share(float(r.amount), total)}
        for r in grp.sort_values("amount", ascending=False).itertuples()
    ]

    raw = pi[pi["item_group"] == RAW]
    raw_total = _sum(raw, "amount")
    cur_items = _group_items(raw)
    prev_items = _group_items(pi_prev[pi_prev["item_group"] == RAW]) if not pi_prev.empty else _group_items(pi_prev)
    prev_map = {r.item_code: float(r.rate) for r in prev_items.itertuples()}
    # latest purchase line per item -> last paid rate
    last: dict[str, tuple[str, float]] = {}
    if not raw.empty:
        latest = raw[raw["qty"] > 0].sort_values("date").groupby("item_code").tail(1)
        for r in latest.itertuples():
            last[r.item_code] = (r.date.strftime("%Y-%m-%d"), float(r.amount) / float(r.qty))
    head = _head(cur_items, limit)
    items = []
    for r in head.itertuples():
        p_rate = prev_map.get(r.item_code)
        last_date, last_rate = last.get(r.item_code, (None, None))
        items.append({
            "item_code": r.item_code, "item_name": r.item_name, "uom": r.uom, "qty": round(float(r.qty), 3),
            "amount": round(float(r.amount), 2), "rate": round(float(r.rate), 2), "invoices": int(r.entries),
            "share_pct": _share(float(r.amount), raw_total),
            "last_rate": round(last_rate, 2) if last_rate is not None else None, "last_date": last_date,
            "prev_rate": round(p_rate, 2) if p_rate else None, "rate_change_pct": _pct(float(r.rate), p_rate) if p_rate else None,
        })
    return {
        **empty, "total": round(total, 2), "raw_total": round(raw_total, 2), "invoices": _nunique(pi, "parent"),
        "distinct_items": _nunique(cur_items, "item_code"), "by_supplier": by_supplier, "by_group": by_group, "items": items,
        "other_amount": round(raw_total - _sum(head, "amount"), 2),
    }


# ------------------------------------------------------------------ stock on hand

async def stock(rng: DateRange, limit: int = 20, group: str = RAW, refresh: bool = False) -> dict[str, Any]:
    """Current stock of one item group (default raw material) with days of cover at this range's usage."""
    st, se = await asyncio.gather(_stock_frame(refresh), _production_frame(rng, refresh))
    empty = {"source": "bin", "range": rng.as_dict(), "item_group": group, "as_of": today_local().isoformat(), "total_value": 0.0,
             "distinct_items": 0, "by_warehouse": [], "items": [], "other_value": 0.0, "groups": []}
    if st.empty:
        return empty
    groups = [
        {"item_group": r.item_group, "value": round(float(r.value), 2), "items": int(r.items)}
        for r in st.groupby("item_group", as_index=False).agg(value=("value", "sum"), items=("item_code", "nunique")).sort_values("value", ascending=False).itertuples()
    ]
    df = st[st["item_group"] == group]
    if df.empty:
        return {**empty, "groups": groups}
    total = _sum(df, "value")
    wh = df.groupby("warehouse", as_index=False).agg(value=("value", "sum"), items=("item_code", "nunique"))
    by_warehouse = [
        {"warehouse": outlet_label(r.warehouse), "value": round(float(r.value), 2), "items": int(r.items), "share_pct": _share(float(r.value), total)}
        for r in wh.sort_values("value", ascending=False).itertuples()
    ]
    used: dict[str, float] = {}
    if not se.empty:
        c = se[(se["kind"] == "consumed") & (se["item_group"] == group)]
        used = {str(k): float(v) for k, v in c.groupby("item_code")["qty"].sum().items()}
    per = df.groupby("item_code", as_index=False).agg(
        item_name=("item_name", "first"), uom=("uom", "first"), qty=("qty", "sum"), value=("value", "sum"), warehouses=("warehouse", "nunique"),
    ).sort_values("value", ascending=False).reset_index(drop=True)
    head = _head(per, limit)
    items = []
    for r in head.itertuples():
        daily_use = used.get(r.item_code, 0.0) / rng.days if rng.days else 0.0
        items.append({
            "item_code": r.item_code, "item_name": r.item_name, "uom": r.uom, "qty": round(float(r.qty), 3), "value": round(float(r.value), 2),
            "valuation_rate": round(float(r.value) / float(r.qty), 2) if r.qty else 0.0, "warehouses": int(r.warehouses),
            "share_pct": _share(float(r.value), total),
            "used_qty": round(used.get(r.item_code, 0.0), 3), "daily_use": round(daily_use, 3),
            "days_cover": round(float(r.qty) / daily_use, 1) if daily_use > 0 and r.qty > 0 else None,
        })
    return {
        **empty, "total_value": round(total, 2), "distinct_items": _nunique(per, "item_code"), "by_warehouse": by_warehouse,
        "items": items, "other_value": round(total - _sum(head, "value"), 2), "groups": groups,
    }


# ------------------------------------------------------------------ department detail

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
ENTRY_LIMIT = 300


def weekday_set(weekdays: str | None) -> set[int] | None:
    """'Mon,Sat' -> {0, 5}; None / empty / unknown names -> None (no weekday filter)."""
    if not weekdays:
        return None
    out = {WEEKDAYS.index(w.strip()[:3].title()) for w in weekdays.split(",") if w.strip()[:3].title() in WEEKDAYS}
    return out or None


def _only_weekdays(df: pd.DataFrame, sel: set[int] | None) -> pd.DataFrame:
    """Rows whose posting date falls on one of the selected weekdays (all rows when sel is None)."""
    if sel is None or df.empty:
        return df
    return df[df["date"].dt.weekday.isin(sel)]


def _days(rng: DateRange, sel: set[int] | None) -> pd.DatetimeIndex:
    days = pd.date_range(rng.start, rng.end, freq="D")
    return days if sel is None else days[[d.weekday() in sel for d in days]]


async def departments(rng: DateRange, limit: int = 10, refresh: bool = False, weekdays: str | None = None) -> dict[str, Any]:
    """Material consumption per production department in detail: summary vs the previous window,
    day-by-day (or month) matrix, weekday averages, top items per department and every production entry."""
    prev = rng.previous()
    sel = weekday_set(weekdays)
    se, se_prev = await asyncio.gather(_production_frame(rng, refresh), _production_frame(prev))
    se, se_prev = _only_weekdays(se, sel), _only_weekdays(se_prev, sel)
    empty = {"source": "stock_entry", "range": rng.as_dict(), "previous_range": prev.as_dict(), "granularity": rng.granularity,
             "weekdays": sorted(WEEKDAYS[i] for i in sel) if sel else [],
             "total": 0.0, "departments": [], "daily": [], "weekday": [], "items": {}, "entries": [], "entries_total": 0}
    if se.empty:
        return empty
    consumed = se[se["kind"] == "consumed"].copy()
    if consumed.empty:
        return empty
    consumed["dept"] = consumed["warehouse"].map(outlet_label)
    produced = se[se["kind"] == "produced"]
    total = _sum(consumed, "amount")
    days_in_range = _days(rng, sel)

    # --- summary per department, with the previous window
    prev_c = se_prev[se_prev["kind"] == "consumed"].copy() if not se_prev.empty else se_prev
    prev_map: dict[str, float] = {}
    if not prev_c.empty:
        prev_c["dept"] = prev_c["warehouse"].map(outlet_label)
        prev_map = {str(k): float(v) for k, v in prev_c.groupby("dept")["amount"].sum().items()}
    g = consumed.groupby("dept", as_index=False).agg(
        amount=("amount", "sum"), qty=("qty", "sum"), entries=("parent", "nunique"), items=("item_code", "nunique"),
        active_days=("date", lambda s: s.dt.normalize().nunique()),
    ).sort_values("amount", ascending=False)
    depts = [str(d) for d in g["dept"]]
    summary = [
        {"department": r.dept, "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3), "entries": int(r.entries), "items": int(r.items),
         "active_days": int(r.active_days), "share_pct": _share(float(r.amount), total),
         "avg_per_active_day": round(float(r.amount) / int(r.active_days), 2) if r.active_days else 0.0,
         "prev_amount": round(prev_map.get(r.dept, 0.0), 2), "delta_pct": _pct(float(r.amount), prev_map.get(r.dept, 0.0))}
        for r in g.itertuples()
    ]

    # --- day x department matrix (calendar days, zero-filled), monthly over long ranges
    pivot = consumed.pivot_table(index=consumed["date"].dt.normalize(), columns="dept", values="amount", aggfunc="sum", fill_value=0.0)
    pivot = pivot.reindex(days_in_range, fill_value=0.0).reindex(columns=depts, fill_value=0.0)
    entries_per_day = consumed.groupby(consumed["date"].dt.normalize())["parent"].nunique().reindex(days_in_range, fill_value=0)
    if rng.granularity == "month":
        pivot = pivot.groupby(pivot.index.to_period("M")).sum()
        pivot.index = pivot.index.to_timestamp()
        entries_per_day = entries_per_day.groupby(entries_per_day.index.to_period("M")).sum()
        entries_per_day.index = entries_per_day.index.to_timestamp()
    daily = [
        {"period": d.strftime("%Y-%m-%d"), "weekday": WEEKDAYS[d.weekday()], "total": round(float(row.sum()), 2),
         "entries": int(entries_per_day.get(d, 0)), "by_department": {k: round(float(v), 2) for k, v in row.items()}}
        for d, row in pivot.iterrows()
    ]

    # --- weekday averages: per department, average over the days of that weekday that had any production
    day_tot = consumed.groupby(consumed["date"].dt.normalize())["amount"].sum()
    active = day_tot[day_tot > 0]
    wd_pivot = consumed.pivot_table(index=consumed["date"].dt.normalize(), columns="dept", values="amount", aggfunc="sum", fill_value=0.0)
    weekday = []
    for i, name in enumerate(WEEKDAYS):
        days = [d for d in active.index if d.weekday() == i]
        n = len(days)
        if n == 0:
            weekday.append({"weekday": name, "days": 0, "avg_total": 0.0, "by_department": {d: 0.0 for d in depts}})
            continue
        sub = wd_pivot.reindex(days, fill_value=0.0)
        weekday.append({
            "weekday": name, "days": n, "avg_total": round(float(active.loc[days].sum()) / n, 2),
            "by_department": {d: round(float(sub[d].sum()) / n, 2) if d in sub.columns else 0.0 for d in depts},
        })

    # --- top items per department
    items: dict[str, list[dict[str, Any]]] = {}
    for d in depts:
        sub = consumed[consumed["dept"] == d]
        gi = _group_items(sub)
        dt = _sum(sub, "amount")
        items[d] = [
            {"item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group, "uom": r.uom, "qty": round(float(r.qty), 3),
             "amount": round(float(r.amount), 2), "rate": round(float(r.rate), 2), "entries": int(r.entries), "share_pct": _share(float(r.amount), dt)}
            for r in _head(gi, limit).itertuples()
        ]

    # --- every production entry: what each batch used and what it produced
    prod_by_parent = None
    if not produced.empty:
        prod_by_parent = produced.groupby("parent").agg(produced_value=("amount", "sum"), produced_qty=("qty", "sum"), produced_items=("item_code", "nunique"))
    ge = consumed.groupby(["parent", "dept"], as_index=False).agg(
        date=("date", "first"), purpose=("purpose", "first"), amount=("amount", "sum"), qty=("qty", "sum"), items=("item_code", "nunique"),
    ).sort_values(["date", "parent"], ascending=[False, False])
    entries = []
    for r in ge.head(ENTRY_LIMIT).itertuples():
        pv = pq = 0.0
        pi_n = 0
        if prod_by_parent is not None and r.parent in prod_by_parent.index:
            p = prod_by_parent.loc[r.parent]
            pv, pq, pi_n = float(p["produced_value"]), float(p["produced_qty"]), int(p["produced_items"])
        entries.append({
            "name": r.parent, "date": r.date.strftime("%Y-%m-%d"), "weekday": WEEKDAYS[r.date.weekday()], "purpose": r.purpose, "department": r.dept,
            "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3), "items": int(r.items),
            "produced_value": round(pv, 2), "produced_qty": round(pq, 3), "produced_items": pi_n,
            "yield_pct": round(pv / float(r.amount) * 100, 1) if r.amount else None,
        })
    return {
        **empty, "total": round(total, 2), "departments": summary, "daily": daily, "weekday": weekday, "items": items,
        "entries": entries, "entries_total": int(len(ge)),
    }


# ------------------------------------------------------------------ production (finished goods) detail

def _dept_of_entry(consumed: pd.DataFrame) -> pd.Series:
    """Stock Entry name -> producing department (the department its materials were issued from)."""
    if consumed.empty:
        return pd.Series(dtype=object)
    return consumed.assign(dept=consumed["warehouse"].map(outlet_label)).groupby("parent")["dept"].first()


def _product_rows(df: pd.DataFrame, total: float, prev: pd.DataFrame | None, limit: int) -> list[dict[str, Any]]:
    """Top products by value with the change vs the previous window."""
    g = _group_items(df)
    prev_map: dict[str, tuple[float, float]] = {}
    if prev is not None and not prev.empty:
        prev_map = {r.item_code: (float(r.amount), float(r.qty)) for r in _group_items(prev).itertuples()}
    out = []
    for r in _head(g, limit).itertuples():
        p_val, p_qty = prev_map.get(r.item_code, (0.0, 0.0))
        out.append({
            "item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group, "uom": r.uom,
            "qty": round(float(r.qty), 3), "amount": round(float(r.amount), 2), "rate": round(float(r.rate), 2),
            "entries": int(r.entries), "share_pct": _share(float(r.amount), total),
            "prev_amount": round(p_val, 2), "delta_pct": _pct(float(r.amount), p_val),
            "prev_qty": round(p_qty, 3), "qty_delta_pct": _pct(float(r.qty), p_qty),
        })
    return out


async def production(rng: DateRange, limit: int = 15, refresh: bool = False, weekdays: str | None = None) -> dict[str, Any]:
    """Finished goods produced in detail: per producing department vs the previous window, day-by-day
    (or month) matrix, weekday averages, top products (overall and per department) and every production entry."""
    prev = rng.previous()
    sel = weekday_set(weekdays)
    se, se_prev = await asyncio.gather(_production_frame(rng, refresh), _production_frame(prev))
    se, se_prev = _only_weekdays(se, sel), _only_weekdays(se_prev, sel)
    empty = {"source": "stock_entry", "range": rng.as_dict(), "previous_range": prev.as_dict(), "granularity": rng.granularity,
             "weekdays": sorted(WEEKDAYS[i] for i in sel) if sel else [],
             "total": 0.0, "total_qty": 0.0, "distinct_items": 0, "departments": [], "daily": [], "weekday": [],
             "items": [], "items_by_department": {}, "entries": [], "entries_total": 0}
    if se.empty:
        return empty
    produced = se[se["kind"] == "produced"].copy()
    if produced.empty:
        return empty
    consumed = se[se["kind"] == "consumed"]
    produced["dept"] = produced["parent"].map(_dept_of_entry(consumed)).fillna("Unassigned")
    total = _sum(produced, "amount")
    days_in_range = _days(rng, sel)

    prev_p = se_prev[se_prev["kind"] == "produced"].copy() if not se_prev.empty else se_prev
    prev_map: dict[str, float] = {}
    if not prev_p.empty:
        prev_p["dept"] = prev_p["parent"].map(_dept_of_entry(se_prev[se_prev["kind"] == "consumed"])).fillna("Unassigned")
        prev_map = {str(k): float(v) for k, v in prev_p.groupby("dept")["amount"].sum().items()}

    g = produced.groupby("dept", as_index=False).agg(
        amount=("amount", "sum"), qty=("qty", "sum"), entries=("parent", "nunique"), items=("item_code", "nunique"),
        active_days=("date", lambda s: s.dt.normalize().nunique()),
    ).sort_values("amount", ascending=False)
    depts = [str(d) for d in g["dept"]]
    summary = [
        {"department": r.dept, "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3), "entries": int(r.entries), "items": int(r.items),
         "active_days": int(r.active_days), "share_pct": _share(float(r.amount), total),
         "avg_per_active_day": round(float(r.amount) / int(r.active_days), 2) if r.active_days else 0.0,
         "prev_amount": round(prev_map.get(r.dept, 0.0), 2), "delta_pct": _pct(float(r.amount), prev_map.get(r.dept, 0.0))}
        for r in g.itertuples()
    ]

    by_day = produced["date"].dt.normalize()
    pivot = produced.pivot_table(index=by_day, columns="dept", values="amount", aggfunc="sum", fill_value=0.0)
    pivot = pivot.reindex(days_in_range, fill_value=0.0).reindex(columns=depts, fill_value=0.0)
    qty_day = produced.groupby(by_day)["qty"].sum().reindex(days_in_range, fill_value=0.0)
    entries_day = produced.groupby(by_day)["parent"].nunique().reindex(days_in_range, fill_value=0)
    if rng.granularity == "month":
        key = pivot.index.to_period("M")
        pivot = pivot.groupby(key).sum()
        pivot.index = pivot.index.to_timestamp()
        qty_day = qty_day.groupby(qty_day.index.to_period("M")).sum()
        qty_day.index = qty_day.index.to_timestamp()
        entries_day = entries_day.groupby(entries_day.index.to_period("M")).sum()
        entries_day.index = entries_day.index.to_timestamp()
    daily = [
        {"period": d.strftime("%Y-%m-%d"), "weekday": WEEKDAYS[d.weekday()], "total": round(float(row.sum()), 2),
         "qty": round(float(qty_day.get(d, 0.0)), 3), "entries": int(entries_day.get(d, 0)),
         "by_department": {k: round(float(v), 2) for k, v in row.items()}}
        for d, row in pivot.iterrows()
    ]

    day_tot = produced.groupby(by_day)["amount"].sum()
    active = day_tot[day_tot > 0]
    wd_pivot = produced.pivot_table(index=by_day, columns="dept", values="amount", aggfunc="sum", fill_value=0.0)
    weekday = []
    for i, name in enumerate(WEEKDAYS):
        days = [d for d in active.index if d.weekday() == i]
        n = len(days)
        if n == 0:
            weekday.append({"weekday": name, "days": 0, "avg_total": 0.0, "by_department": {d: 0.0 for d in depts}})
            continue
        sub = wd_pivot.reindex(days, fill_value=0.0)
        weekday.append({
            "weekday": name, "days": n, "avg_total": round(float(active.loc[days].sum()) / n, 2),
            "by_department": {d: round(float(sub[d].sum()) / n, 2) if d in sub.columns else 0.0 for d in depts},
        })

    items = _product_rows(produced, total, prev_p, limit)
    items_by_department = {
        d: _product_rows(produced[produced["dept"] == d], _sum(produced[produced["dept"] == d], "amount"),
                         prev_p[prev_p["dept"] == d] if not prev_p.empty else None, limit)
        for d in depts
    }

    used_by_parent = consumed.groupby("parent").agg(used=("amount", "sum"), materials=("item_code", "nunique")) if not consumed.empty else None
    ge = produced.groupby("parent", as_index=False).agg(
        date=("date", "first"), purpose=("purpose", "first"), dept=("dept", "first"), amount=("amount", "sum"), qty=("qty", "sum"), items=("item_code", "nunique"),
    ).sort_values(["date", "parent"], ascending=[False, False])
    top_products: dict[str, list[str]] = {}
    for parent, sub in produced.sort_values("amount", ascending=False).groupby("parent"):
        top_products[str(parent)] = [f"{r.item_name} ×{num_fmt(r.qty)}" for r in sub.head(3).itertuples()]
    entries = []
    for r in ge.head(ENTRY_LIMIT).itertuples():
        used = materials = 0.0
        if used_by_parent is not None and r.parent in used_by_parent.index:
            u = used_by_parent.loc[r.parent]
            used, materials = float(u["used"]), int(u["materials"])
        entries.append({
            "name": r.parent, "date": r.date.strftime("%Y-%m-%d"), "weekday": WEEKDAYS[r.date.weekday()], "purpose": r.purpose, "department": r.dept,
            "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3), "items": int(r.items),
            "used": round(used, 2), "materials": int(materials),
            "yield_pct": round(float(r.amount) / used * 100, 1) if used else None,
            "top_products": top_products.get(r.parent, []),
        })
    return {
        **empty, "total": round(total, 2), "total_qty": round(_sum(produced, "qty"), 3), "distinct_items": _nunique(produced, "item_code"),
        "departments": summary, "daily": daily, "weekday": weekday, "items": items, "items_by_department": items_by_department,
        "entries": entries, "entries_total": int(len(ge)),
    }


def num_fmt(v: float) -> str:
    """7.0 -> '7', 2.5 -> '2.5' (for the short product list on an entry)."""
    f = float(v)
    return str(int(f)) if f.is_integer() else f"{f:g}"


# ------------------------------------------------------------------ purchases / consumption / output detail

FLOW_METRICS = (
    ("purchased", "Raw material purchased"), ("purchased_all", "All purchases"),
    ("consumed", "Material consumed"), ("produced", "Finished goods produced"),
)


def _day_series(df: pd.DataFrame, mask: pd.Series | None, days: pd.DatetimeIndex, col: str = "amount") -> pd.Series:
    if df.empty:
        return pd.Series(0.0, index=days)
    d = df if mask is None else df[mask]
    return d.groupby(d["date"].dt.normalize())[col].sum().reindex(days, fill_value=0.0)


def _day_count(df: pd.DataFrame, mask: pd.Series | None, days: pd.DatetimeIndex) -> pd.Series:
    if df.empty:
        return pd.Series(0, index=days)
    d = df if mask is None else df[mask]
    return d.groupby(d["date"].dt.normalize())["parent"].nunique().reindex(days, fill_value=0)


def _flow_frame(pi: pd.DataFrame, se: pd.DataFrame, rng: DateRange, sel: set[int] | None = None) -> pd.DataFrame:
    """One row per calendar day (of the selected weekdays): purchased (raw), purchased_all, consumed, produced, invoices, entries."""
    days = _days(rng, sel)
    out = pd.DataFrame({"date": days})
    out["purchased"] = _day_series(pi, pi["item_group"] == RAW if not pi.empty else None, days).values
    out["purchased_all"] = _day_series(pi, None, days).values
    out["consumed"] = _day_series(se, se["kind"] == "consumed" if not se.empty else None, days).values
    out["produced"] = _day_series(se, se["kind"] == "produced" if not se.empty else None, days).values
    out["invoices"] = _day_count(pi, None, days).values
    out["entries"] = _day_count(se, se["kind"] == "consumed" if not se.empty else None, days).values
    return out


def _flow_summary(cur: pd.DataFrame, prev: pd.DataFrame) -> list[dict[str, Any]]:
    rows = []
    for key, label in FLOW_METRICS:
        total = float(cur[key].sum())
        active = int((cur[key] > 0).sum())
        count_col = "invoices" if key.startswith("purchased") else "entries"
        rows.append({
            "key": key, "label": label, "total": round(total, 2), "active_days": active,
            "avg_per_active_day": round(total / active, 2) if active else 0.0,
            "avg_per_day": round(total / len(cur), 2) if len(cur) else 0.0,
            "documents": int(cur.loc[cur[key] > 0, count_col].sum()) if active else 0,
            "prev_total": round(float(prev[key].sum()), 2), "delta_pct": _pct(total, float(prev[key].sum())),
        })
    return rows


async def flow(rng: DateRange, refresh: bool = False, weekdays: str | None = None) -> dict[str, Any]:
    """Purchases, consumption and output in detail: per metric summary vs the previous window, day-by-day
    (or month) table with running totals, weekday averages, and every purchase invoice in the range."""
    prev = rng.previous()
    sel = weekday_set(weekdays)
    pi, pi_prev, se, se_prev = await asyncio.gather(
        _purchase_frame(rng, refresh), _purchase_frame(prev), _production_frame(rng, refresh), _production_frame(prev),
    )
    pi, pi_prev, se, se_prev = (_only_weekdays(x, sel) for x in (pi, pi_prev, se, se_prev))
    cur = _flow_frame(pi, se, rng, sel)
    before = _flow_frame(pi_prev, se_prev, prev, sel)
    summary = _flow_summary(cur, before)
    tot = {k: float(cur[k].sum()) for k, _ in FLOW_METRICS}
    ptot = {k: float(before[k].sum()) for k, _ in FLOW_METRICS}
    ratios = {
        "gap": round(tot["purchased"] - tot["consumed"], 2),
        "prev_gap": round(ptot["purchased"] - ptot["consumed"], 2),
        "yield_pct": round(tot["produced"] / tot["consumed"] * 100, 1) if tot["consumed"] else None,
        "prev_yield_pct": round(ptot["produced"] / ptot["consumed"] * 100, 1) if ptot["consumed"] else None,
        "consumed_pct_of_purchased": round(tot["consumed"] / tot["purchased"] * 100, 1) if tot["purchased"] else None,
    }

    # --- day-by-day (or month) with running totals
    table = cur.copy()
    if rng.granularity == "month":
        g = table.groupby(table["date"].dt.to_period("M")).agg(
            purchased=("purchased", "sum"), purchased_all=("purchased_all", "sum"), consumed=("consumed", "sum"),
            produced=("produced", "sum"), invoices=("invoices", "sum"), entries=("entries", "sum"),
        ).reset_index()
        g["date"] = g["date"].dt.to_timestamp()
        table = g
    for k in ("purchased", "consumed", "produced"):
        table[f"cum_{k}"] = table[k].cumsum()
    daily = [
        {
            "period": r.date.strftime("%Y-%m-%d"), "weekday": WEEKDAYS[r.date.weekday()],
            "purchased": round(float(r.purchased), 2), "purchased_all": round(float(r.purchased_all), 2),
            "consumed": round(float(r.consumed), 2), "produced": round(float(r.produced), 2),
            "invoices": int(r.invoices), "entries": int(r.entries),
            "gap": round(float(r.purchased) - float(r.consumed), 2),
            "yield_pct": round(float(r.produced) / float(r.consumed) * 100, 1) if r.consumed else None,
            "cum_purchased": round(float(r.cum_purchased), 2), "cum_consumed": round(float(r.cum_consumed), 2),
            "cum_produced": round(float(r.cum_produced), 2), "cum_gap": round(float(r.cum_purchased) - float(r.cum_consumed), 2),
        }
        for r in table.itertuples()
    ]

    # --- weekday pattern: average per calendar day of that weekday (zero days count), plus how many were active
    wd = cur["date"].dt.weekday
    weekday = []
    for i, name in enumerate(WEEKDAYS):
        sub = cur[wd == i]
        n = int(len(sub))
        weekday.append({
            "weekday": name, "days": n,
            "purchased": round(float(sub["purchased"].sum()) / n, 2) if n else 0.0,
            "consumed": round(float(sub["consumed"].sum()) / n, 2) if n else 0.0,
            "produced": round(float(sub["produced"].sum()) / n, 2) if n else 0.0,
            "purchase_days": int((sub["purchased_all"] > 0).sum()), "production_days": int((sub["consumed"] > 0).sum()),
        })

    # --- every purchase invoice in the range
    invoices: list[dict[str, Any]] = []
    total_invoices = 0
    if not pi.empty:
        raw_amt = pi.assign(raw=pi["amount"].where(pi["item_group"] == RAW, 0.0))
        gi = raw_amt.groupby("parent", as_index=False).agg(
            date=("date", "first"), supplier=("supplier", "first"), total=("amount", "sum"), raw=("raw", "sum"),
            items=("item_code", "nunique"), groups=("item_group", lambda s: ", ".join(sorted(set(s)))),
        ).sort_values(["date", "parent"], ascending=[False, False])
        total_invoices = int(len(gi))
        invoices = [
            {"name": r.parent, "date": r.date.strftime("%Y-%m-%d"), "weekday": WEEKDAYS[r.date.weekday()], "supplier": str(r.supplier).strip(),
             "total": round(float(r.total), 2), "raw": round(float(r.raw), 2), "other": round(float(r.total) - float(r.raw), 2),
             "items": int(r.items), "groups": r.groups}
            for r in gi.head(ENTRY_LIMIT).itertuples()
        ]

    return {
        "source": "stock_entry", "range": rng.as_dict(), "previous_range": prev.as_dict(), "granularity": rng.granularity,
        "weekdays": sorted(WEEKDAYS[i] for i in sel) if sel else [],
        "summary": summary, "ratios": ratios, "daily": daily, "weekday": weekday,
        "invoices": invoices, "invoices_total": total_invoices,
    }
