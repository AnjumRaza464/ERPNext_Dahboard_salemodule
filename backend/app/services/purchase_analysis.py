"""Purchase analysis for the Stock Tracking tab: who sold what, on which day, into which warehouse, at what rate.

Built on **Purchase Invoice** lines (every line, not grouped), so the same payload can be rolled up supplier-wise,
day-wise, weekday-wise, item-wise and supplier x item, and still list every invoice and every line. Returns
(is_return) come through with negative qty / amount and net off the totals. The opening / conversion placeholder
items (COSTING_EXCLUDE_ITEMS) are left out, as everywhere else in the dashboard.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pandas as pd

from ..cache import cached
from ..dates import DateRange, today_local
from ..erpnext_client import get_client
from .sales import outlet_label
from .stock import _excluded_mask, _num, _r

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
PI_LINE_COLS = ["parent", "date", "supplier", "is_return", "item_code", "item_name", "item_group", "warehouse", "uom", "qty", "rate", "amount"]
PI_CHUNK = 200


def weekday_set(weekdays: str | None) -> set[int] | None:
    """'Mon,Sat' -> {0, 5}; None / empty / unknown names -> None (no weekday filter)."""
    if not weekdays:
        return None
    out = {WEEKDAYS.index(w.strip()[:3].title()) for w in weekdays.split(",") if w.strip()[:3].title() in WEEKDAYS}
    return out or None


async def _purchase_lines(rng: DateRange, refresh: bool = False) -> pd.DataFrame:
    """Every Purchase Invoice line in the range (supplier, day, item, warehouse, qty in stock UOM, rate, amount)."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        filters = [["docstatus", "=", 1], ["company", "=", c.company], ["posting_date", ">=", rng.start.isoformat()], ["posting_date", "<=", rng.end.isoformat()]]
        heads = await c.get_all("Purchase Invoice", ["name", "posting_date", "supplier_name", "is_return"], filters)
        if not heads:
            return []
        meta = {h["name"]: h for h in heads}
        names = list(meta)
        results = await asyncio.gather(*[
            c.get_all("Purchase Invoice Item",
                      ["parent", "item_code", "item_name", "item_group", "warehouse", "uom", "qty", "stock_uom", "stock_qty", "rate", "base_net_amount"],
                      [["parent", "in", names[i:i + PI_CHUNK]]], parent="Purchase Invoice", page_size=2000)
            for i in range(0, len(names), PI_CHUNK)
        ])
        out: list[dict[str, Any]] = []
        for chunk in results:
            for r in chunk:
                h = meta.get(r["parent"]) or {}
                stock_qty = r.get("stock_qty") or 0
                qty = stock_qty if stock_qty else (r.get("qty") or 0)
                uom = r.get("stock_uom") if stock_qty else (r.get("uom") or "")
                amount = r.get("base_net_amount") or 0
                out.append({
                    "parent": r["parent"], "date": h.get("posting_date"), "supplier": (h.get("supplier_name") or "Unknown").strip(), "is_return": int(h.get("is_return") or 0),
                    "item_code": r["item_code"], "item_name": r.get("item_name") or r["item_code"], "item_group": r.get("item_group") or "Ungrouped",
                    "warehouse": r.get("warehouse") or "", "uom": uom or "", "qty": qty, "rate": (amount / qty) if qty else (r.get("rate") or 0), "amount": amount,
                })
        return out

    rows, _ = await cached(f"stock:pi:{rng.key()}", _load, refresh=refresh and rng.end >= today_local())
    df = pd.DataFrame(rows, columns=PI_LINE_COLS)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = _num(df, ("qty", "rate", "amount"))
    df["weekday"] = df["date"].dt.weekday.map(lambda i: WEEKDAYS[int(i)] if pd.notna(i) else "")
    df["wh_label"] = df["warehouse"].map(outlet_label)
    return df[~_excluded_mask(df)]


def _share(value: float, total: float) -> float:
    return round(value / total * 100, 1) if total else 0.0


def _pct(cur: float, prev: float | None) -> float | None:
    return round((cur - prev) / abs(prev) * 100, 1) if prev else None


def _active_days(df: pd.DataFrame) -> int:
    return int(df["date"].dt.normalize().nunique()) if not df.empty else 0


def _rate_stats(df: pd.DataFrame) -> dict[str, Any]:
    """Average / lowest / highest / last paid rate over the positive (non-return) lines of one item."""
    pos = df[df["qty"] > 0]
    if pos.empty:
        return {"avg_rate": 0.0, "min_rate": None, "max_rate": None, "last_rate": None, "last_date": None, "first_date": None}
    last = pos.sort_values("date").iloc[-1]
    qty = float(pos["qty"].sum())
    return {
        "avg_rate": _r(pos["amount"].sum() / qty) if qty else 0.0,
        "min_rate": _r(pos["rate"].min()), "max_rate": _r(pos["rate"].max()), "last_rate": _r(last["rate"]),
        "last_date": last["date"].strftime("%Y-%m-%d"), "first_date": pos["date"].min().strftime("%Y-%m-%d"),
    }


def _top_item(df: pd.DataFrame | None) -> dict[str, Any] | None:
    if df is None or df.empty:
        return None
    g = df.groupby(["item_code", "item_name"])["amount"].sum().sort_values(ascending=False)
    if g.empty:
        return None
    (code, name), amount = g.index[0], float(g.iloc[0])
    return {"item_code": code, "item_name": name, "amount": _r(amount)}


def _by_supplier_map(df: pd.DataFrame | None) -> dict[str, float]:
    if df is None or df.empty:
        return {}
    return {s: _r(v) for s, v in df.groupby("supplier")["amount"].sum().items()}


def _weekday_list(df: pd.DataFrame) -> str:
    seen = set(df["weekday"])
    return ", ".join(w for w in WEEKDAYS if w in seen)


async def purchases(rng: DateRange, refresh: bool = False, weekdays: str | None = None) -> dict[str, Any]:
    """Purchase analysis for the range: totals vs the previous window, supplier-wise (with the days and items each
    supplier delivered), day-by-day (or month) with a per-supplier split, weekday pattern, item-wise with rate watch,
    supplier x item pairs, every invoice and every invoice line."""
    prev = rng.previous()
    sel = weekday_set(weekdays)
    cur, pre = await asyncio.gather(_purchase_lines(rng, refresh), _purchase_lines(prev))
    if sel is not None:
        cur = cur[cur["date"].dt.weekday.isin(sel)] if not cur.empty else cur
        pre = pre[pre["date"].dt.weekday.isin(sel)] if not pre.empty else pre
    days_in_sel = [d for d in pd.date_range(rng.start, rng.end, freq="D") if sel is None or d.weekday() in sel]
    empty = {
        "source": "purchase_invoice", "range": rng.as_dict(), "previous_range": prev.as_dict(), "granularity": rng.granularity,
        "weekdays": [WEEKDAYS[i] for i in sorted(sel)] if sel else [],
        "summary": {"total": 0.0, "prev_total": 0.0, "delta_pct": None, "invoices": 0, "returns": 0, "return_amount": 0.0, "suppliers": 0, "items": 0, "lines": 0, "qty": 0.0,
                    "active_days": 0, "days": len(days_in_sel), "avg_per_invoice": 0.0, "avg_per_active_day": 0.0, "avg_per_day": 0.0,
                    "largest_invoice": None, "top_supplier": None, "top_item": None, "top_group": None, "first_date": None, "last_date": None},
        "suppliers": [], "by_supplier": [], "by_group": [], "by_warehouse": [], "by_weekday": [], "daily": [], "items": [], "supplier_items": [], "invoices": [], "lines": [],
    }
    if cur.empty:
        return empty

    total = float(cur["amount"].sum())
    prev_total = float(pre["amount"].sum()) if not pre.empty else 0.0

    # --- supplier-wise
    prev_sup = pre.groupby("supplier")["amount"].sum().to_dict() if not pre.empty else {}
    by_supplier: list[dict[str, Any]] = []
    for sup, g in cur.groupby("supplier"):
        amt = float(g["amount"].sum())
        n_inv = int(g["parent"].nunique())
        active = _active_days(g)
        wd = g.groupby("weekday")["amount"].sum()
        by_supplier.append({
            "supplier": sup, "amount": _r(amt), "share_pct": _share(amt, total), "qty": _r(g["qty"].sum(), 3),
            "invoices": n_inv, "returns": int(g.loc[g["is_return"] == 1, "parent"].nunique()), "items": int(g["item_code"].nunique()), "lines": int(len(g)),
            "active_days": active, "first_date": g["date"].min().strftime("%Y-%m-%d"), "last_date": g["date"].max().strftime("%Y-%m-%d"),
            "avg_per_invoice": _r(amt / n_inv) if n_inv else 0.0, "avg_per_active_day": _r(amt / active) if active else 0.0,
            "groups": ", ".join(sorted(g["item_group"].unique())), "warehouses": ", ".join(sorted(g["wh_label"].unique())), "weekdays": _weekday_list(g),
            "top_item": _top_item(g), "by_weekday": {w: _r(wd.get(w, 0.0)) for w in WEEKDAYS},
            "prev_amount": _r(prev_sup.get(sup, 0.0)), "delta_pct": _pct(amt, prev_sup.get(sup)),
        })
    by_supplier.sort(key=lambda r: r["amount"], reverse=True)
    suppliers = [r["supplier"] for r in by_supplier]

    # --- item group / warehouse roll-ups
    def _roll(key: str, label: str) -> list[dict[str, Any]]:
        out = []
        for k, g in cur.groupby(key):
            amt = float(g["amount"].sum())
            out.append({label: k, "amount": _r(amt), "share_pct": _share(amt, total), "qty": _r(g["qty"].sum(), 3), "items": int(g["item_code"].nunique()),
                        "invoices": int(g["parent"].nunique()), "suppliers": int(g["supplier"].nunique()), "lines": int(len(g)), "active_days": _active_days(g),
                        "supplier_names": ", ".join(sorted(g["supplier"].unique())), "top_item": _top_item(g)})
        return sorted(out, key=lambda r: r["amount"], reverse=True)

    by_group = _roll("item_group", "item_group")
    by_warehouse = _roll("wh_label", "warehouse")

    # --- weekday pattern: how much is bought on each day of the week, and by whom
    by_weekday: list[dict[str, Any]] = []
    for i, w in enumerate(WEEKDAYS):
        if sel is not None and i not in sel:
            continue
        g = cur[cur["weekday"] == w]
        amt = float(g["amount"].sum())
        n_days = sum(1 for d in days_in_sel if d.weekday() == i)
        active = _active_days(g)
        by_weekday.append({
            "weekday": w, "amount": _r(amt), "share_pct": _share(amt, total), "invoices": int(g["parent"].nunique()), "items": int(g["item_code"].nunique()),
            "suppliers": int(g["supplier"].nunique()), "days": n_days, "active_days": active,
            "avg_per_active_day": _r(amt / active) if active else 0.0, "avg_per_day": _r(amt / n_days) if n_days else 0.0,
            "by_supplier": _by_supplier_map(g), "top_item": _top_item(g),
        })

    # --- day by day (or month by month) with the supplier split
    if rng.granularity == "month":
        cur_p = cur.assign(period=cur["date"].dt.to_period("M").dt.start_time)
        periods = pd.date_range(rng.start.replace(day=1), rng.end, freq="MS")
    else:
        cur_p = cur.assign(period=cur["date"].dt.normalize())
        periods = pd.DatetimeIndex(days_in_sel)
    pg = {p: g for p, g in cur_p.groupby("period")}
    daily: list[dict[str, Any]] = []
    running = 0.0
    for p in periods:
        g = pg.get(p)
        amt = float(g["amount"].sum()) if g is not None else 0.0
        running += amt
        daily.append({
            "period": p.strftime("%Y-%m-%d"), "weekday": WEEKDAYS[p.weekday()] if rng.granularity == "day" else "",
            "total": _r(amt), "cum_total": _r(running), "invoices": int(g["parent"].nunique()) if g is not None else 0,
            "suppliers": int(g["supplier"].nunique()) if g is not None else 0, "items": int(g["item_code"].nunique()) if g is not None else 0,
            "lines": int(len(g)) if g is not None else 0, "qty": _r(g["qty"].sum(), 3) if g is not None else 0.0,
            "by_supplier": _by_supplier_map(g), "top_item": _top_item(g),
            "supplier_names": ", ".join(sorted(g["supplier"].unique())) if g is not None else "",
        })

    # --- item-wise with rate watch
    prev_items = pre.groupby("item_code").agg(amount=("amount", "sum"), qty=("qty", "sum")) if not pre.empty else None
    items: list[dict[str, Any]] = []
    for code, g in cur.groupby("item_code"):
        amt = float(g["amount"].sum())
        stats = _rate_stats(g)
        sup = g.groupby("supplier")["amount"].sum().sort_values(ascending=False)
        p_amt = float(prev_items.loc[code, "amount"]) if prev_items is not None and code in prev_items.index else 0.0
        p_qty = float(prev_items.loc[code, "qty"]) if prev_items is not None and code in prev_items.index else 0.0
        p_rate = p_amt / p_qty if p_qty else None
        items.append({
            "item_code": code, "item_name": g["item_name"].iloc[0], "item_group": g["item_group"].iloc[0], "uom": g["uom"].iloc[0],
            "qty": _r(g["qty"].sum(), 3), "amount": _r(amt), "share_pct": _share(amt, total), "invoices": int(g["parent"].nunique()), "lines": int(len(g)),
            "active_days": _active_days(g), "suppliers": int(g["supplier"].nunique()),
            "supplier_names": ", ".join(sup.index), "main_supplier": sup.index[0] if len(sup) else None,
            "main_supplier_share_pct": _share(float(sup.iloc[0]), amt) if len(sup) and amt else 0.0,
            "warehouses": ", ".join(sorted(g["wh_label"].unique())), "weekdays": _weekday_list(g),
            **stats, "prev_amount": _r(p_amt), "prev_qty": _r(p_qty, 3), "delta_pct": _pct(amt, p_amt or None),
            "prev_rate": _r(p_rate) if p_rate else None, "rate_change_pct": _pct(stats["avg_rate"], p_rate) if p_rate and stats["avg_rate"] else None,
        })
    items.sort(key=lambda r: r["amount"], reverse=True)

    # --- supplier x item: which supplier delivered which item, on which days, at what rate
    sup_total = {r["supplier"]: r["amount"] for r in by_supplier}
    supplier_items: list[dict[str, Any]] = []
    for (sup, code), g in cur.groupby(["supplier", "item_code"]):
        amt = float(g["amount"].sum())
        dates = sorted(g["date"].dt.strftime("%Y-%m-%d").unique())
        supplier_items.append({
            "supplier": sup, "item_code": code, "item_name": g["item_name"].iloc[0], "item_group": g["item_group"].iloc[0], "uom": g["uom"].iloc[0],
            "qty": _r(g["qty"].sum(), 3), "amount": _r(amt), "share_of_supplier_pct": _share(amt, sup_total.get(sup, 0.0)), "share_of_total_pct": _share(amt, total),
            "invoices": int(g["parent"].nunique()), "lines": int(len(g)), "active_days": len(dates), "dates": dates, "weekdays": _weekday_list(g), **_rate_stats(g),
        })
    supplier_items.sort(key=lambda r: (-sup_total.get(r["supplier"], 0.0), -r["amount"]))

    # --- every invoice
    invoices: list[dict[str, Any]] = []
    for name, g in cur.groupby("parent"):
        d0 = g["date"].iloc[0]
        invoices.append({
            "name": name, "date": d0.strftime("%Y-%m-%d"), "weekday": WEEKDAYS[d0.weekday()], "supplier": g["supplier"].iloc[0], "is_return": bool(g["is_return"].iloc[0]),
            "warehouse": ", ".join(sorted(g["wh_label"].unique())), "amount": _r(g["amount"].sum()), "qty": _r(g["qty"].sum(), 3), "items": int(g["item_code"].nunique()),
            "lines": int(len(g)), "groups": ", ".join(sorted(g["item_group"].unique())), "top_item": _top_item(g),
        })
    invoices.sort(key=lambda r: (r["date"], r["name"]), reverse=True)

    # --- every line
    e = cur.sort_values(["date", "parent", "amount"], ascending=[False, False, False])
    lines = [{
        "date": r.date.strftime("%Y-%m-%d"), "weekday": r.weekday, "invoice": r.parent, "supplier": r.supplier, "is_return": bool(r.is_return),
        "item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group, "warehouse": r.wh_label, "uom": r.uom,
        "qty": _r(r.qty, 3), "rate": _r(r.rate), "amount": _r(r.amount),
    } for r in e.itertuples()]

    largest = max(invoices, key=lambda r: r["amount"]) if invoices else None
    n_inv = int(cur["parent"].nunique())
    active_days = _active_days(cur)
    returns = cur[cur["is_return"] == 1]
    top_item = items[0] if items else None
    summary = {
        "total": _r(total), "prev_total": _r(prev_total), "delta_pct": _pct(total, prev_total or None),
        "invoices": n_inv, "returns": int(returns["parent"].nunique()), "return_amount": _r(returns["amount"].sum()),
        "suppliers": int(cur["supplier"].nunique()), "items": int(cur["item_code"].nunique()), "lines": int(len(cur)), "qty": _r(cur["qty"].sum(), 3),
        "active_days": active_days, "days": len(days_in_sel),
        "avg_per_invoice": _r(total / n_inv) if n_inv else 0.0, "avg_per_active_day": _r(total / active_days) if active_days else 0.0,
        "avg_per_day": _r(total / len(days_in_sel)) if days_in_sel else 0.0,
        "largest_invoice": {"name": largest["name"], "date": largest["date"], "supplier": largest["supplier"], "amount": largest["amount"]} if largest else None,
        "top_supplier": {"supplier": by_supplier[0]["supplier"], "amount": by_supplier[0]["amount"], "share_pct": by_supplier[0]["share_pct"]} if by_supplier else None,
        "top_item": {"item_code": top_item["item_code"], "item_name": top_item["item_name"], "amount": top_item["amount"], "share_pct": top_item["share_pct"], "main_supplier": top_item["main_supplier"]} if top_item else None,
        "top_group": {"item_group": by_group[0]["item_group"], "amount": by_group[0]["amount"], "share_pct": by_group[0]["share_pct"]} if by_group else None,
        "first_date": cur["date"].min().strftime("%Y-%m-%d"), "last_date": cur["date"].max().strftime("%Y-%m-%d"),
    }
    return {
        **empty, "summary": summary, "suppliers": suppliers, "by_supplier": by_supplier, "by_group": by_group, "by_warehouse": by_warehouse, "by_weekday": by_weekday,
        "daily": daily, "items": items, "supplier_items": supplier_items, "invoices": invoices, "lines": lines,
    }
