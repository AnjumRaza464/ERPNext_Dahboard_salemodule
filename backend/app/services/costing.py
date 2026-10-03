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
from ..config import get_settings
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


def _split_excluded(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(kept, dropped): lines whose item is an opening / conversion placeholder (COSTING_EXCLUDE_ITEMS) are dropped."""
    names = get_settings().costing_excluded_items
    if df.empty or not names:
        return df, df.iloc[0:0]
    mask = df["item_name"].astype(str).str.strip().str.lower().isin(names) | df["item_code"].astype(str).str.strip().str.lower().isin(names)
    return df[~mask], df[mask]


def dept_label(warehouse: str | None) -> str:
    """Warehouse -> department label. Material consumed straight out of Stores (how production was booked before
    the departments were set up on 24 Jun 2026) is labelled so it does not read as a department."""
    label = outlet_label(warehouse)
    return "Stores (direct)" if label == "Stores" else label


# ------------------------------------------------------------------ frames

async def _purchase_frame(rng: DateRange, refresh: bool = False, with_excluded: bool = False) -> pd.DataFrame:
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
    df = _num(df, ("qty", "amount"))
    return df if with_excluded else _split_excluded(df)[0]


async def _production_frame(rng: DateRange, refresh: bool = False, with_excluded: bool = False) -> pd.DataFrame:
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
    df = _num(df, ("qty", "amount"))
    return df if with_excluded else _split_excluded(df)[0]


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
    pi_raw, se_raw = await asyncio.gather(_purchase_frame(rng, with_excluded=True), _production_frame(rng, with_excluded=True))
    pi_drop, se_drop = _split_excluded(pi_raw)[1], _split_excluded(se_raw)[1]
    excluded = {
        "items": sorted(set(pi_drop["item_name"]) | set(se_drop["item_name"])) if not (pi_drop.empty and se_drop.empty) else [],
        "purchases": round(_sum(pi_drop, "amount"), 2),
        "consumed": round(_sum(se_drop[se_drop["kind"] == "consumed"], "amount"), 2) if not se_drop.empty else 0.0,
        "produced": round(_sum(se_drop[se_drop["kind"] == "produced"], "amount"), 2) if not se_drop.empty else 0.0,
    }
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
        "health": {**latest, "today": today_local().isoformat(), "excluded": excluded},
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
        {"department": dept_label(r.warehouse), "amount": round(float(r.amount), 2), "entries": int(r.entries), "items": int(r.items),
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
    consumed["dept"] = consumed["warehouse"].map(dept_label)
    produced = se[se["kind"] == "produced"]
    total = _sum(consumed, "amount")
    days_in_range = _days(rng, sel)

    # --- summary per department, with the previous window
    prev_c = se_prev[se_prev["kind"] == "consumed"].copy() if not se_prev.empty else se_prev
    prev_map: dict[str, float] = {}
    if not prev_c.empty:
        prev_c["dept"] = prev_c["warehouse"].map(dept_label)
        prev_map = {str(k): float(v) for k, v in prev_c.groupby("dept")["amount"].sum().items()}
    g = consumed.groupby("dept", as_index=False).agg(
        amount=("amount", "sum"), qty=("qty", "sum"), entries=("parent", "nunique"), items=("item_code", "nunique"),
        active_days=("date", lambda s: s.dt.normalize().nunique()),
    ).sort_values("amount", ascending=False)
    depts = [str(d) for d in g["dept"]]
    # finished goods booked by the same entries: material cost as a share of what the department produced
    made: dict[str, float] = {}
    if not produced.empty:
        owner = consumed.groupby("parent")["dept"].first()
        made = {str(k): float(v) for k, v in produced.assign(dept=produced["parent"].map(owner)).groupby("dept")["amount"].sum().items()}
    summary = [
        {"department": r.dept, "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3), "entries": int(r.entries), "items": int(r.items),
         "active_days": int(r.active_days), "share_pct": _share(float(r.amount), total),
         "avg_per_active_day": round(float(r.amount) / int(r.active_days), 2) if r.active_days else 0.0,
         "prev_amount": round(prev_map.get(r.dept, 0.0), 2), "delta_pct": _pct(float(r.amount), prev_map.get(r.dept, 0.0)),
         "produced": round(made.get(r.dept, 0.0), 2), "used": round(float(r.amount), 2),
         "cost_pct": round(float(r.amount) / made[r.dept] * 100, 1) if made.get(r.dept) else None}
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
    return consumed.assign(dept=consumed["warehouse"].map(dept_label)).groupby("parent")["dept"].first()


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
    spent: dict[str, float] = {}
    if not consumed.empty:
        spent = {str(k): float(v) for k, v in consumed.assign(dept=consumed["warehouse"].map(dept_label)).groupby("dept")["amount"].sum().items()}
    summary = [
        {"department": r.dept, "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3), "entries": int(r.entries), "items": int(r.items),
         "active_days": int(r.active_days), "share_pct": _share(float(r.amount), total),
         "avg_per_active_day": round(float(r.amount) / int(r.active_days), 2) if r.active_days else 0.0,
         "prev_amount": round(prev_map.get(r.dept, 0.0), 2), "delta_pct": _pct(float(r.amount), prev_map.get(r.dept, 0.0)),
         "produced": round(float(r.amount), 2), "used": round(spent.get(r.dept, 0.0), 2),
         "cost_pct": round(spent[r.dept] / float(r.amount) * 100, 1) if spent.get(r.dept) and r.amount else None}
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


# ------------------------------------------------------------------ store issue (Stores -> departments / outlet)

STORE_LABEL = "Stores"
TR_COLS = ["parent", "date", "source", "target", "item_code", "item_name", "item_group", "uom", "qty", "amount"]


async def _transfer_frame(rng: DateRange, refresh: bool = False, with_excluded: bool = False) -> pd.DataFrame:
    """Material Transfer lines: one row per entry x item x source warehouse x target warehouse."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        heads = await c.get_all("Stock Entry", ["name", "posting_date"], _filters(rng, [["purpose", "=", "Material Transfer"]]))
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
                out.append({
                    "parent": r["parent"], "date": h.get("posting_date"),
                    "source": outlet_label(r.get("s_warehouse")), "target": outlet_label(r.get("t_warehouse")),
                    "item_code": r["item_code"], "item_name": r.get("item_name") or r["item_code"],
                    "item_group": r.get("item_group") or "Ungrouped", "uom": r.get("stock_uom") or "",
                    "qty": r.get("qty") or 0, "amount": r.get("amount") or 0,
                })
        return out

    rows, _ = await cached(f"costing:tr:{rng.key()}", _load, refresh=_refresh_ok(rng, refresh))
    df = pd.DataFrame(rows, columns=TR_COLS)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = _num(df, ("qty", "amount"))
    return df if with_excluded else _split_excluded(df)[0]


def _is_department(label: str) -> bool:
    return label.strip().lower().endswith("department")


async def store_issues(rng: DateRange, limit: int = 0, refresh: bool = False, weekdays: str | None = None) -> dict[str, Any]:
    """What left the Stores warehouse on Material Transfer entries: per destination (production departments,
    outlet) vs the previous window, set against what each department then consumed in production and what it
    still holds; day-by-day matrix, every item per destination, and every transfer entry."""
    prev = rng.previous()
    sel = weekday_set(weekdays)
    tr, tr_prev, se, st = await asyncio.gather(
        _transfer_frame(rng, refresh), _transfer_frame(prev), _production_frame(rng, refresh), _stock_frame(refresh),
    )
    tr, tr_prev, se = _only_weekdays(tr, sel), _only_weekdays(tr_prev, sel), _only_weekdays(se, sel)
    empty = {"source": "stock_entry", "range": rng.as_dict(), "previous_range": prev.as_dict(), "granularity": rng.granularity,
             "weekdays": sorted(WEEKDAYS[i] for i in sel) if sel else [], "store": STORE_LABEL,
             "total": 0.0, "to_departments": 0.0, "to_other": 0.0, "consumed_total": 0.0,
             "targets": [], "daily": [], "items": {}, "entries": [], "entries_total": 0}
    issued = tr[tr["source"] == STORE_LABEL] if not tr.empty else tr
    if issued.empty:
        return empty
    total = _sum(issued, "amount")
    days_in_range = _days(rng, sel)

    # what each department then used in production (same range), and what it holds right now
    consumed = se[se["kind"] == "consumed"].copy() if not se.empty else se
    if not consumed.empty:
        consumed["dept"] = consumed["warehouse"].map(dept_label)
    cons_amt = {str(k): float(v) for k, v in consumed.groupby("dept")["amount"].sum().items()} if not consumed.empty else {}
    cons_qty = {str(k): float(v) for k, v in consumed.groupby("dept")["qty"].sum().items()} if not consumed.empty else {}
    balance = {}
    if not st.empty:
        balance = {str(k): float(v) for k, v in st.assign(label=st["warehouse"].map(outlet_label)).groupby("label")["value"].sum().items()}

    prev_issued = tr_prev[tr_prev["source"] == STORE_LABEL] if not tr_prev.empty else tr_prev
    prev_map = {str(k): float(v) for k, v in prev_issued.groupby("target")["amount"].sum().items()} if not prev_issued.empty else {}

    g = issued.groupby("target", as_index=False).agg(
        amount=("amount", "sum"), qty=("qty", "sum"), entries=("parent", "nunique"), items=("item_code", "nunique"),
        active_days=("date", lambda s: s.dt.normalize().nunique()),
    ).sort_values("amount", ascending=False)
    targets = [str(t) for t in g["target"]]
    summary = []
    for r in g.itertuples():
        dept = _is_department(r.target)
        used = cons_amt.get(r.target, 0.0) if dept else None
        summary.append({
            "target": r.target, "is_department": dept, "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3),
            "entries": int(r.entries), "items": int(r.items), "active_days": int(r.active_days), "share_pct": _share(float(r.amount), total),
            "avg_per_active_day": round(float(r.amount) / int(r.active_days), 2) if r.active_days else 0.0,
            "prev_amount": round(prev_map.get(r.target, 0.0), 2), "delta_pct": _pct(float(r.amount), prev_map.get(r.target, 0.0)),
            "consumed": round(used, 2) if used is not None else None,
            "consumed_qty": round(cons_qty.get(r.target, 0.0), 3) if dept else None,
            # issued minus consumed: positive = material still sitting in the department (or a valuation difference)
            "variance": round(float(r.amount) - used, 2) if used is not None else None,
            "variance_qty": round(float(r.qty) - cons_qty.get(r.target, 0.0), 3) if dept else None,
            "balance_now": round(balance.get(r.target, 0.0), 2),
        })
    to_departments = sum(s["amount"] for s in summary if s["is_department"])

    # day x destination matrix, with that day's production consumption alongside
    by_day = issued["date"].dt.normalize()
    pivot = issued.pivot_table(index=by_day, columns="target", values="amount", aggfunc="sum", fill_value=0.0)
    pivot = pivot.reindex(days_in_range, fill_value=0.0).reindex(columns=targets, fill_value=0.0)
    entries_day = issued.groupby(by_day)["parent"].nunique().reindex(days_in_range, fill_value=0)
    cons_day = pd.Series(0.0, index=days_in_range)
    if not consumed.empty:
        cons_day = consumed.groupby(consumed["date"].dt.normalize())["amount"].sum().reindex(days_in_range, fill_value=0.0)
    if rng.granularity == "month":
        pivot = pivot.groupby(pivot.index.to_period("M")).sum()
        pivot.index = pivot.index.to_timestamp()
        entries_day = entries_day.groupby(entries_day.index.to_period("M")).sum()
        entries_day.index = entries_day.index.to_timestamp()
        cons_day = cons_day.groupby(cons_day.index.to_period("M")).sum()
        cons_day.index = cons_day.index.to_timestamp()
    dept_cols = [t for t in targets if _is_department(t)]
    daily = []
    for d, row in pivot.iterrows():
        to_dept = float(row[dept_cols].sum()) if dept_cols else 0.0
        used = float(cons_day.get(d, 0.0))
        daily.append({
            "period": d.strftime("%Y-%m-%d"), "weekday": WEEKDAYS[d.weekday()], "total": round(float(row.sum()), 2),
            "entries": int(entries_day.get(d, 0)), "by_target": {k: round(float(v), 2) for k, v in row.items()},
            "to_departments": round(to_dept, 2), "consumed": round(used, 2), "variance": round(to_dept - used, 2),
        })

    # every item per destination, against what that department consumed of it
    items: dict[str, list[dict[str, Any]]] = {}
    for t in targets:
        sub = issued[issued["target"] == t]
        gi = _group_items(sub)
        tt = _sum(sub, "amount")
        used_q: dict[str, float] = {}
        used_a: dict[str, float] = {}
        if _is_department(t) and not consumed.empty:
            c = consumed[consumed["dept"] == t]
            used_q = {str(k): float(v) for k, v in c.groupby("item_code")["qty"].sum().items()}
            used_a = {str(k): float(v) for k, v in c.groupby("item_code")["amount"].sum().items()}
        items[t] = [
            {"item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group, "uom": r.uom, "qty": round(float(r.qty), 3),
             "amount": round(float(r.amount), 2), "rate": round(float(r.rate), 2), "entries": int(r.entries), "share_pct": _share(float(r.amount), tt),
             "consumed_qty": round(used_q.get(r.item_code, 0.0), 3) if _is_department(t) else None,
             "consumed_amount": round(used_a.get(r.item_code, 0.0), 2) if _is_department(t) else None,
             "variance_qty": round(float(r.qty) - used_q.get(r.item_code, 0.0), 3) if _is_department(t) else None}
            for r in _head(gi, limit).itertuples()
        ]

    ge = issued.groupby(["parent", "target"], as_index=False).agg(
        date=("date", "first"), amount=("amount", "sum"), qty=("qty", "sum"), items=("item_code", "nunique"),
        groups=("item_group", lambda s: ", ".join(sorted(set(s)))),
    ).sort_values(["date", "parent"], ascending=[False, False])
    entries = [
        {"name": r.parent, "date": r.date.strftime("%Y-%m-%d"), "weekday": WEEKDAYS[r.date.weekday()], "target": r.target,
         "amount": round(float(r.amount), 2), "qty": round(float(r.qty), 3), "items": int(r.items), "groups": r.groups}
        for r in ge.head(ENTRY_LIMIT).itertuples()
    ]
    return {
        **empty, "total": round(total, 2), "to_departments": round(to_departments, 2), "to_other": round(total - to_departments, 2),
        "consumed_total": round(sum(v for k, v in cons_amt.items() if _is_department(k)), 2),
        "targets": summary, "daily": daily, "items": items, "entries": entries, "entries_total": int(len(ge)),
    }


# ------------------------------------------------------------------ produced vs sold

SOLD_COLS = ["item_code", "item_name", "item_group", "uom", "qty", "amount"]


async def _sold_frame(rng: DateRange, refresh: bool = False) -> pd.DataFrame:
    """Items sold on bills in the range, in stock units: one row per item (qty in stock UOM, net amount)."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        out: list[dict[str, Any]] = []
        for parent_dt, child_dt, extra in sales.ITEM_SOURCES:
            names = [r["name"] for r in await c.get_all(parent_dt, ["name"], sales.live._filters(rng, extra + [["is_return", "=", 0]]))]
            if not names:
                continue
            results = await asyncio.gather(*[
                c.get_list(
                    child_dt,
                    ["item_code", "item_name", "item_group", "stock_uom", "sum(stock_qty) as qty", "sum(base_net_amount) as amount"],
                    [["parent", "in", chunk]], group_by="item_code", parent=parent_dt, limit_page_length=None,
                )
                for chunk in _chunks(names)
            ])
            for chunk in results:
                for r in chunk:
                    out.append({"item_code": r["item_code"], "item_name": r.get("item_name") or r["item_code"],
                                "item_group": r.get("item_group") or "Ungrouped", "uom": r.get("stock_uom") or "",
                                "qty": r.get("qty") or 0, "amount": r.get("amount") or 0})
        return out

    rows, _ = await cached(f"costing:sold:{rng.key()}", _load, refresh=_refresh_ok(rng, refresh))
    df = pd.DataFrame(rows, columns=SOLD_COLS)
    if df.empty:
        return df
    df = _num(df, ("qty", "amount"))
    df = df.groupby("item_code", as_index=False).agg(item_name=("item_name", "first"), item_group=("item_group", "first"), uom=("uom", "first"), qty=("qty", "sum"), amount=("amount", "sum"))
    return _split_excluded(df)[0]


async def produced_vs_sold(rng: DateRange, limit: int = 0, refresh: bool = False) -> dict[str, Any]:
    """Per product: quantity produced (production entries) plus quantity bought in (purchase invoices), against the
    quantity sold on bills in the same range. The gap is unsold stock, wastage, or sales out of earlier stock."""
    se, pi, sold = await asyncio.gather(_production_frame(rng, refresh), _purchase_frame(rng, refresh), _sold_frame(rng, refresh))
    empty = {"source": "stock_entry", "range": rng.as_dict(), "items": [], "distinct_items": 0, "groups": [],
             "totals": {"produced_qty": 0.0, "produced_value": 0.0, "purchased_qty": 0.0, "available_qty": 0.0, "sold_qty": 0.0,
                        "sold_amount": 0.0, "variance_qty": 0.0, "unsold_value": 0.0, "sell_through_pct": None}}
    produced = se[se["kind"] == "produced"] if not se.empty else se
    made = _group_items(produced)[["item_code", "item_name", "item_group", "uom", "qty", "amount"]] if not produced.empty else pd.DataFrame(columns=SOLD_COLS)
    if sold.empty and made.empty:
        return empty
    bought = _group_items(pi)[["item_code", "item_name", "item_group", "uom", "qty", "amount"]] if not pi.empty else pd.DataFrame(columns=SOLD_COLS)

    m = made.rename(columns={"qty": "produced_qty", "amount": "produced_value"}).merge(
        sold.rename(columns={"qty": "sold_qty", "amount": "sold_amount"}), on="item_code", how="outer", suffixes=("", "_s"))
    for col in ("item_name", "item_group", "uom"):
        m[col] = m[col].fillna(m[f"{col}_s"])
    m = m.drop(columns=["item_name_s", "item_group_s", "uom_s"])
    # bought-in stock only matters for things that are produced or sold (resale items, bought-in finished goods)
    b = bought[bought["item_code"].isin(m["item_code"])].rename(columns={"qty": "purchased_qty", "amount": "purchased_value"})[["item_code", "purchased_qty", "purchased_value"]]
    m = m.merge(b, on="item_code", how="left")
    for col in ("produced_qty", "produced_value", "sold_qty", "sold_amount", "purchased_qty", "purchased_value"):
        m[col] = pd.to_numeric(m[col], errors="coerce").fillna(0.0)
    m["available_qty"] = m["produced_qty"] + m["purchased_qty"]
    m["variance_qty"] = m["available_qty"] - m["sold_qty"]
    m = m.sort_values(["sold_amount", "produced_value"], ascending=False).reset_index(drop=True)

    def _row(r: Any) -> dict[str, Any]:
        price = r.sold_amount / r.sold_qty if r.sold_qty else 0.0
        std = r.produced_value / r.produced_qty if r.produced_qty else (r.purchased_value / r.purchased_qty if r.purchased_qty else price)
        return {
            "item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group, "uom": r.uom,
            "produced_qty": round(float(r.produced_qty), 3), "produced_value": round(float(r.produced_value), 2),
            "purchased_qty": round(float(r.purchased_qty), 3), "available_qty": round(float(r.available_qty), 3),
            "sold_qty": round(float(r.sold_qty), 3), "sold_amount": round(float(r.sold_amount), 2),
            "avg_price": round(float(price), 2), "std_rate": round(float(std), 2),
            # positive = made / bought but not sold in the range; negative = sold out of earlier stock
            "variance_qty": round(float(r.variance_qty), 3),
            "unsold_value": round(float(max(r.variance_qty, 0.0) * std), 2),
            "sell_through_pct": round(float(r.sold_qty) / float(r.available_qty) * 100, 1) if r.available_qty else None,
        }

    rows = [_row(r) for r in _head(m, limit).itertuples()]
    all_rows = rows if limit <= 0 else [_row(r) for r in m.itertuples()]
    avail = float(m["available_qty"].sum())
    grp = m.groupby("item_group", as_index=False).agg(produced_qty=("produced_qty", "sum"), purchased_qty=("purchased_qty", "sum"),
                                                     sold_qty=("sold_qty", "sum"), sold_amount=("sold_amount", "sum"), items=("item_code", "nunique"))
    groups = [
        {"item_group": r.item_group, "produced_qty": round(float(r.produced_qty), 3), "purchased_qty": round(float(r.purchased_qty), 3),
         "sold_qty": round(float(r.sold_qty), 3), "sold_amount": round(float(r.sold_amount), 2), "items": int(r.items),
         "sell_through_pct": round(float(r.sold_qty) / (float(r.produced_qty) + float(r.purchased_qty)) * 100, 1) if (r.produced_qty + r.purchased_qty) else None}
        for r in grp.sort_values("sold_amount", ascending=False).itertuples()
    ]
    return {
        **empty, "items": rows, "distinct_items": int(len(m)), "groups": groups,
        "totals": {
            "produced_qty": round(float(m["produced_qty"].sum()), 3), "produced_value": round(float(m["produced_value"].sum()), 2),
            "purchased_qty": round(float(m["purchased_qty"].sum()), 3), "available_qty": round(avail, 3),
            "sold_qty": round(float(m["sold_qty"].sum()), 3), "sold_amount": round(float(m["sold_amount"].sum()), 2),
            "variance_qty": round(float(m["variance_qty"].sum()), 3),
            "unsold_value": round(sum(x["unsold_value"] for x in all_rows), 2),
            "sell_through_pct": round(float(m["sold_qty"].sum()) / avail * 100, 1) if avail else None,
        },
    }


# ------------------------------------------------------------------ stock adjustments (reconciliation)

async def adjustments(rng: DateRange, refresh: bool = False) -> dict[str, Any]:
    """Stock Reconciliation postings in the range: what the stock count changed, per item and warehouse."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        sle, items = await asyncio.gather(
            c.get_all("Stock Ledger Entry",
                      ["posting_date", "voucher_no", "item_code", "warehouse", "actual_qty", "qty_after_transaction", "valuation_rate", "stock_value_difference", "stock_uom"],
                      [["company", "=", c.company], ["is_cancelled", "=", 0], ["voucher_type", "=", "Stock Reconciliation"],
                       ["posting_date", ">=", rng.start.isoformat()], ["posting_date", "<=", rng.end.isoformat()]], page_size=2000),
            c.get_all("Item", ["name", "item_name", "item_group"], [["is_stock_item", "=", 1]], page_size=2000),
        )
        imap = {i["name"]: i for i in items}
        return [{**r, "item_name": imap.get(r["item_code"], {}).get("item_name") or r["item_code"],
                 "item_group": imap.get(r["item_code"], {}).get("item_group") or "Ungrouped"} for r in sle]

    rows, _ = await cached(f"costing:adj:{rng.key()}", _load, refresh=_refresh_ok(rng, refresh))
    empty = {"source": "bin", "range": rng.as_dict(), "net_value": 0.0, "increase": 0.0, "decrease": 0.0, "vouchers": 0, "lines": 0,
             "by_group": [], "by_warehouse": [], "items": []}
    if not rows:
        return empty
    df = pd.DataFrame(rows)
    df = _num(df, ("actual_qty", "qty_after_transaction", "valuation_rate", "stock_value_difference"))
    df = df.sort_values("stock_value_difference", key=lambda s: s.abs(), ascending=False)
    val = df["stock_value_difference"]
    by_group = [
        {"item_group": k, "value": round(float(v), 2)}
        for k, v in df.groupby("item_group")["stock_value_difference"].sum().sort_values(key=lambda s: s.abs(), ascending=False).items()
    ]
    by_wh = [
        {"warehouse": outlet_label(k), "value": round(float(v), 2)}
        for k, v in df.groupby("warehouse")["stock_value_difference"].sum().sort_values(key=lambda s: s.abs(), ascending=False).items()
    ]
    items = [
        {"date": str(r.posting_date), "voucher": r.voucher_no, "item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group,
         "warehouse": outlet_label(r.warehouse), "uom": r.stock_uom or "", "qty_change": round(float(r.actual_qty), 3),
         "qty_after": round(float(r.qty_after_transaction), 3), "rate_after": round(float(r.valuation_rate), 2),
         "value_change": round(float(r.stock_value_difference), 2)}
        for r in df.itertuples()
    ]
    return {
        **empty, "net_value": round(float(val.sum()), 2), "increase": round(float(val[val > 0].sum()), 2), "decrease": round(float(val[val < 0].sum()), 2),
        "vouchers": int(df["voucher_no"].nunique()), "lines": int(len(df)), "by_group": by_group, "by_warehouse": by_wh, "items": items,
    }


# ------------------------------------------------------------------ one-card summary of the whole chain

async def _chain(rng: DateRange, refresh: bool = False) -> dict[str, Any]:
    """The material chain for one range: bought -> issued by Stores -> consumed -> produced -> sent to outlet -> sold."""
    pi, tr, se, sold, days = await asyncio.gather(
        _purchase_frame(rng, refresh), _transfer_frame(rng, refresh), _production_frame(rng, refresh),
        _sold_frame(rng, refresh), sales._check_days(rng, refresh),
    )
    daily = sales._daily(days, rng)
    net_sales = float(daily["net"].sum()) if not daily.empty else 0.0
    bills = int(daily["checks"].sum()) if not daily.empty else 0

    raw_pi = pi[pi["item_group"] == RAW] if not pi.empty else pi
    issued = tr[tr["source"] == STORE_LABEL] if not tr.empty else tr
    dept_mask = issued["target"].map(_is_department) if not issued.empty else None
    to_dept = issued[dept_mask] if dept_mask is not None else issued
    to_other = issued[~dept_mask] if dept_mask is not None else issued
    # finished goods (and anything else) moved on to the outlet from a warehouse other than Stores
    dispatch = tr[(tr["source"] != STORE_LABEL) & ~tr["target"].map(_is_department)] if not tr.empty else tr
    consumed = se[se["kind"] == "consumed"] if not se.empty else se
    produced = se[se["kind"] == "produced"] if not se.empty else se

    c_total, p_total = _sum(consumed, "amount"), _sum(produced, "amount")
    sold_qty = _sum(sold, "qty")
    made_qty = _sum(produced, "qty")
    bought_fg_qty = 0.0
    if not pi.empty and not sold.empty:
        bought_fg_qty = float(pi[pi["item_code"].isin(set(sold["item_code"]) | set(produced["item_code"] if not produced.empty else []))]["qty"].sum())
    available = made_qty + bought_fg_qty

    # per department: issued in, consumed, produced
    depts: dict[str, dict[str, float]] = {}
    if not to_dept.empty:
        for k, v in to_dept.groupby("target")["amount"].sum().items():
            depts.setdefault(str(k), {"issued": 0.0, "consumed": 0.0, "produced": 0.0})["issued"] = float(v)
    owner = pd.Series(dtype=object)
    if not consumed.empty:
        lab = consumed.assign(dept=consumed["warehouse"].map(dept_label))
        owner = lab.groupby("parent")["dept"].first()
        for k, v in lab.groupby("dept")["amount"].sum().items():
            depts.setdefault(str(k), {"issued": 0.0, "consumed": 0.0, "produced": 0.0})["consumed"] = float(v)
    if not produced.empty:
        for k, v in produced.assign(dept=produced["parent"].map(owner).fillna("Unassigned")).groupby("dept")["amount"].sum().items():
            depts.setdefault(str(k), {"issued": 0.0, "consumed": 0.0, "produced": 0.0})["produced"] = float(v)

    return {
        "purchased_raw": round(_sum(raw_pi, "amount"), 2), "purchased_all": round(_sum(pi, "amount"), 2),
        "purchase_invoices": _nunique(pi, "parent"), "purchased_raw_items": _nunique(raw_pi, "item_code"),
        "issued": round(_sum(issued, "amount"), 2), "issued_to_departments": round(_sum(to_dept, "amount"), 2),
        "issued_to_other": round(_sum(to_other, "amount"), 2), "issue_entries": _nunique(issued, "parent"),
        "consumed": round(c_total, 2), "consumed_raw": round(_sum(consumed[consumed["item_group"] == RAW], "amount"), 2) if not consumed.empty else 0.0,
        "consumed_packaging": round(_sum(consumed[consumed["item_group"] == PACKAGING], "amount"), 2) if not consumed.empty else 0.0,
        "production_entries": _nunique(se, "parent"), "materials_used": _nunique(consumed, "item_code"),
        "produced": round(p_total, 2), "produced_qty": round(made_qty, 3), "products": _nunique(produced, "item_code"),
        "dispatched": round(_sum(dispatch, "amount"), 2), "dispatched_qty": round(_sum(dispatch, "qty"), 3), "dispatch_entries": _nunique(dispatch, "parent"),
        "bought_in_qty": round(bought_fg_qty, 3),
        "sold": round(net_sales, 2), "sold_qty": round(sold_qty, 3), "bills": bills, "products_sold": _nunique(sold, "item_code"),
        # ratios
        "material_cost_pct": round(c_total / net_sales * 100, 1) if net_sales else None,
        "material_margin": round(net_sales - c_total, 2),
        "consumed_pct_of_issued": round(c_total / _sum(to_dept, "amount") * 100, 1) if _sum(to_dept, "amount") else None,
        "output_per_100": round(p_total / c_total * 100, 1) if c_total else None,
        "sell_through_pct": round(sold_qty / available * 100, 1) if available else None,
        "not_sold_qty": round(available - sold_qty, 3),
        "departments": [
            {"department": k, "issued": round(v["issued"], 2), "consumed": round(v["consumed"], 2), "produced": round(v["produced"], 2),
             "cost_pct": round(v["consumed"] / v["produced"] * 100, 1) if v["produced"] else None,
             "share_pct": _share(v["consumed"], c_total)}
            for k, v in sorted(depts.items(), key=lambda kv: -kv[1]["consumed"])
        ],
    }


CHAIN_DELTAS = ("purchased_raw", "purchased_all", "issued", "issued_to_departments", "consumed", "produced", "produced_qty",
                "dispatched", "sold", "sold_qty", "bills", "material_margin")
CHAIN_POINTS = ("material_cost_pct", "sell_through_pct", "output_per_100", "consumed_pct_of_issued")


async def summary(rng: DateRange, refresh: bool = False) -> dict[str, Any]:
    """Everything on the Costing tab in one payload: the chain bought -> issued -> consumed -> produced -> sent to the
    outlet -> sold, each step against the previous window, per-department lines, the ratios that matter, and stock."""
    prev = rng.previous()
    cur, before, st, adj = await asyncio.gather(_chain(rng, refresh), _chain(prev), _stock_frame(refresh), adjustments(rng, refresh))
    raw_stock = st[st["item_group"] == RAW] if not st.empty else st
    raw_value = _sum(raw_stock, "value")
    daily_use = cur["consumed_raw"] / rng.days if rng.days else 0.0
    return {
        "source": "stock_entry", "range": rng.as_dict(), "previous_range": prev.as_dict(),
        "current": cur, "previous": {k: v for k, v in before.items() if k != "departments"},
        "delta_pct": {k: _pct(float(cur[k]), float(before[k])) for k in CHAIN_DELTAS},
        "delta_points": {k: (round(cur[k] - before[k], 1) if cur[k] is not None and before[k] is not None else None) for k in CHAIN_POINTS},
        "stock": {
            "raw_value": round(raw_value, 2), "raw_items": _nunique(raw_stock, "item_code"),
            "raw_days_cover": round(raw_value / daily_use, 1) if daily_use > 0 else None,
            "total_value": round(_sum(st, "value"), 2),
        },
        "adjustments": {"net_value": adj["net_value"], "vouchers": adj["vouchers"]},
    }
