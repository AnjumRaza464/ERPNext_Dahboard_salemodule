"""Stock tracking: where every unit of stock was at the start of the range, what came in, what went out,
where it stands at the end of the range and right now.

Built on the **Stock Ledger Entry** (one line per item x warehouse per posting) and the **Bin**
(current balance per item x warehouse). ERPNext does not keep a balance per date, so the balance at the
end of the range is worked back from today's Bin: closing = current - movements posted after the range,
and opening = closing - (in - out) inside the range.

Movements are labelled by what posted them: Purchase Invoice (bought), Stock Entry by purpose
(Material Transfer, Repack = production), Stock Reconciliation (count), POS / Sales Invoice (sold),
Delivery Note. The opening / conversion placeholder items (COSTING_EXCLUDE_ITEMS) are left out, as
everywhere else in the dashboard.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pandas as pd

from ..cache import cached
from ..config import get_settings
from ..dates import DateRange, today_local
from ..erpnext_client import get_client
from .sales import outlet_label

SLE_COLS = ["date", "time", "voucher_type", "voucher_no", "item_code", "item_name", "item_group", "warehouse", "uom", "qty", "qty_after", "rate", "value"]
BIN_COLS = ["item_code", "item_name", "item_group", "warehouse", "uom", "qty", "value", "rate"]
LOW_DAYS = 7.0  # days of cover below which an item is flagged as running low

KIND_LABELS = {
    "Purchase Invoice": "Purchase", "Purchase Receipt": "Purchase",
    "Stock Reconciliation": "Stock count", "POS Invoice": "POS sale", "Sales Invoice": "Sale",
    "Delivery Note": "Delivery", "Stock Entry": "Stock Entry",
}
PURPOSE_LABELS = {"Material Transfer": "Transfer", "Repack": "Production", "Manufacture": "Production", "Material Issue": "Issue", "Material Receipt": "Receipt"}


def _num(df: pd.DataFrame, cols: tuple[str, ...]) -> pd.DataFrame:
    for col in cols:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0).astype(float)
    return df


def _r(v: Any, d: int = 2) -> float:
    out = round(float(v), d)
    return 0.0 if out == 0 else out  # no "-0" in the UI


def _excluded_mask(df: pd.DataFrame) -> pd.Series:
    names = get_settings().costing_excluded_items
    if df.empty or not names:
        return pd.Series(False, index=df.index)
    return df["item_name"].astype(str).str.strip().str.lower().isin(names) | df["item_code"].astype(str).str.strip().str.lower().isin(names)


async def _items() -> dict[str, dict[str, Any]]:
    async def _load() -> dict[str, dict[str, Any]]:
        rows = await get_client().get_all("Item", ["name", "item_name", "item_group", "stock_uom"], [["is_stock_item", "=", 1]], page_size=2000)
        return {r["name"]: r for r in rows}

    value, _ = await cached("stock:items", _load)
    return value


async def _own_warehouses() -> set[str]:
    async def _load() -> list[str]:
        c = get_client()
        rows = await c.get_all("Warehouse", ["name"], [["company", "=", c.company], ["is_group", "=", 0]])
        return [r["name"] for r in rows]

    value, _ = await cached("stock:warehouses", _load)
    return set(value)


async def _ledger_frame(start: str, refresh: bool = False) -> pd.DataFrame:
    """Every stock ledger line posted on or after `start` (up to today), with the movement kind resolved."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        base = [["company", "=", c.company], ["is_cancelled", "=", 0], ["posting_date", ">=", start]]
        sle, entries, imap = await asyncio.gather(
            c.get_all("Stock Ledger Entry",
                      ["posting_date", "posting_time", "voucher_type", "voucher_no", "item_code", "warehouse", "actual_qty",
                       "qty_after_transaction", "valuation_rate", "stock_value_difference", "stock_uom"],
                      base, order_by="posting_date asc, posting_time asc, creation asc", page_size=2000),
            c.get_all("Stock Entry", ["name", "purpose"], [["docstatus", "=", 1], ["company", "=", c.company], ["posting_date", ">=", start]]),
            _items(),
        )
        purpose = {e["name"]: e.get("purpose") or "" for e in entries}
        out: list[dict[str, Any]] = []
        for r in sle:
            it = imap.get(r["item_code"], {})
            vt = r.get("voucher_type") or ""
            kind = KIND_LABELS.get(vt, vt)
            if vt == "Stock Entry":
                kind = PURPOSE_LABELS.get(purpose.get(r.get("voucher_no") or "", ""), "Stock Entry")
            out.append({
                "date": r["posting_date"], "time": str(r.get("posting_time") or "")[:5], "voucher_type": kind, "voucher_no": r.get("voucher_no") or "",
                "item_code": r["item_code"], "item_name": it.get("item_name") or r["item_code"], "item_group": it.get("item_group") or "Ungrouped",
                "warehouse": r.get("warehouse") or "", "uom": r.get("stock_uom") or it.get("stock_uom") or "",
                "qty": r.get("actual_qty") or 0, "qty_after": r.get("qty_after_transaction") or 0,
                "rate": r.get("valuation_rate") or 0, "value": r.get("stock_value_difference") or 0,
            })
        return out

    rows, _ = await cached(f"stock:sle:{start}", _load, refresh=refresh)
    df = pd.DataFrame(rows, columns=SLE_COLS)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = _num(df, ("qty", "qty_after", "rate", "value"))
    return df[~_excluded_mask(df)]


async def _bin_frame(refresh: bool = False) -> pd.DataFrame:
    """Current balance per item x warehouse (every Bin, including empty ones)."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        bins, imap = await asyncio.gather(
            c.get_all("Bin", ["item_code", "warehouse", "actual_qty", "stock_value", "valuation_rate", "stock_uom"], page_size=2000),
            _items(),
        )
        return [{
            "item_code": b["item_code"], "item_name": imap.get(b["item_code"], {}).get("item_name") or b["item_code"],
            "item_group": imap.get(b["item_code"], {}).get("item_group") or "Ungrouped", "warehouse": b["warehouse"],
            "uom": b.get("stock_uom") or "", "qty": b.get("actual_qty") or 0, "value": b.get("stock_value") or 0, "rate": b.get("valuation_rate") or 0,
        } for b in bins]

    rows, _ = await cached("stock:bins", _load, refresh=refresh)
    df = pd.DataFrame(rows, columns=BIN_COLS)
    if df.empty:
        return df
    df = _num(df, ("qty", "value", "rate"))
    return df[~_excluded_mask(df)]


async def _last_movement() -> dict[tuple[str, str], str]:
    """Most recent posting per item x warehouse over the whole ledger (for idle-stock detection)."""

    async def _load() -> list[dict[str, Any]]:
        c = get_client()
        return await c.get_list("Stock Ledger Entry", ["item_code", "warehouse", "max(posting_date) as last_date"],
                                [["company", "=", c.company], ["is_cancelled", "=", 0]], group_by="item_code, warehouse", limit_page_length=None)

    rows, _ = await cached("stock:last", _load)
    return {(r["item_code"], r["warehouse"]): str(r["last_date"]) for r in rows if r.get("last_date")}


def _status(current: float, days_cover: float | None, moved: bool, opening: float) -> str:
    if current <= 0:
        return "out" if (moved or opening > 0) else "empty"
    if days_cover is not None and days_cover < LOW_DAYS:
        return "low"
    if not moved:
        return "idle"
    return "ok"


def _agg(df: pd.DataFrame, key: str, label: str) -> list[dict[str, Any]]:
    """Opening / in / out / closing / current per `key` from the per-item table."""
    if df.empty:
        return []
    g = df.groupby(key, as_index=False).agg(
        opening_value=("opening_value", "sum"), in_value=("in_value", "sum"), out_value=("out_value", "sum"),
        closing_value=("closing_value", "sum"), current_value=("current_value", "sum"), items=("item_code", "nunique"),
        low=("status", lambda s: int((s == "low").sum())), out=("status", lambda s: int((s == "out").sum())),
    ).sort_values("current_value", ascending=False)
    return [{
        label: r[key], "opening_value": _r(r["opening_value"]), "in_value": _r(r["in_value"]), "out_value": _r(r["out_value"]),
        "net_value": _r(r["in_value"] - r["out_value"]), "closing_value": _r(r["closing_value"]), "current_value": _r(r["current_value"]),
        "items": int(r["items"]), "low": int(r["low"]), "out": int(r["out"]),
    } for _, r in g.iterrows()]


async def tracking(rng: DateRange, refresh: bool = False) -> dict[str, Any]:
    """Stock position and movement for the range: per item x warehouse (opening, in, out, closing, current, days of
    cover, last movement, status), rolled up per warehouse, item group and movement kind, day by day, and every
    ledger line in the range."""
    today = today_local()
    sle, bins, last, own = await asyncio.gather(_ledger_frame(rng.start.isoformat(), refresh), _bin_frame(refresh), _last_movement(), _own_warehouses())
    if own:
        if not sle.empty:
            sle = sle[sle["warehouse"].isin(own)]
        if not bins.empty:
            bins = bins[bins["warehouse"].isin(own)]
    empty = {
        "source": "bin", "range": rng.as_dict(), "as_of": today.isoformat(), "granularity": rng.granularity,
        "summary": {"opening_value": 0.0, "in_value": 0.0, "out_value": 0.0, "net_value": 0.0, "closing_value": 0.0, "current_value": 0.0,
                    "items": 0, "warehouses": 0, "entries": 0, "lines": 0, "low": 0, "out": 0, "idle": 0, "in_qty": 0.0, "out_qty": 0.0},
        "by_warehouse": [], "by_group": [], "by_kind": [], "daily": [], "items": [], "entries": [],
    }
    if sle.empty and bins.empty:
        return empty

    end_ts = pd.Timestamp(rng.end)
    in_range = sle[sle["date"] <= end_ts] if not sle.empty else sle
    after = sle[sle["date"] > end_ts] if not sle.empty else sle

    def _per_key(df: pd.DataFrame, prefix: str) -> pd.DataFrame:
        if df.empty:
            return pd.DataFrame(columns=["item_code", "warehouse", f"{prefix}_qty", f"{prefix}_value"])
        g = df.groupby(["item_code", "warehouse"], as_index=False).agg(q=("qty", "sum"), v=("value", "sum"))
        return g.rename(columns={"q": f"{prefix}_qty", "v": f"{prefix}_value"})

    def _flows(df: pd.DataFrame) -> pd.DataFrame:
        cols = ["item_code", "warehouse", "in_qty", "out_qty", "in_value", "out_value", "lines", "last_in_range"]
        if df.empty:
            return pd.DataFrame(columns=cols)
        d = df.assign(
            in_qty=df["qty"].clip(lower=0), out_qty=(-df["qty"]).clip(lower=0),
            in_value=df["value"].clip(lower=0), out_value=(-df["value"]).clip(lower=0),
        )
        g = d.groupby(["item_code", "warehouse"], as_index=False).agg(
            in_qty=("in_qty", "sum"), out_qty=("out_qty", "sum"), in_value=("in_value", "sum"), out_value=("out_value", "sum"),
            lines=("qty", "size"), last_in_range=("date", "max"),
        )
        return g[cols]

    # one row per item x warehouse that has a balance now, a movement in the range, or a movement after it
    base = bins[["item_code", "item_name", "item_group", "warehouse", "uom", "qty", "value", "rate"]].rename(
        columns={"qty": "current_qty", "value": "current_value", "rate": "current_rate"}) if not bins.empty else pd.DataFrame(
        columns=["item_code", "item_name", "item_group", "warehouse", "uom", "current_qty", "current_value", "current_rate"])
    meta = sle[["item_code", "item_name", "item_group", "warehouse", "uom"]].drop_duplicates(["item_code", "warehouse"]) if not sle.empty else None
    if meta is not None:
        base = pd.concat([base, meta[~meta.set_index(["item_code", "warehouse"]).index.isin(base.set_index(["item_code", "warehouse"]).index)]], ignore_index=True)
    base = _num(base, ("current_qty", "current_value", "current_rate"))
    rows = base.merge(_flows(in_range), on=["item_code", "warehouse"], how="left").merge(_per_key(after, "after"), on=["item_code", "warehouse"], how="left")
    rows = _num(rows, ("in_qty", "out_qty", "in_value", "out_value", "lines", "after_qty", "after_value"))
    rows["closing_qty"] = rows["current_qty"] - rows["after_qty"]
    rows["closing_value"] = rows["current_value"] - rows["after_value"]
    rows["opening_qty"] = rows["closing_qty"] - rows["in_qty"] + rows["out_qty"]
    rows["opening_value"] = rows["closing_value"] - rows["in_value"] + rows["out_value"]
    # drop rows that are zero everywhere (empty bins with no movement)
    live = (rows[["current_qty", "closing_qty", "opening_qty", "in_qty", "out_qty"]].abs().sum(axis=1) > 1e-9) | (rows[["current_value", "opening_value", "in_value", "out_value"]].abs().sum(axis=1) > 0.5)
    rows = rows[live].copy()
    if rows.empty:
        return empty

    days = max(rng.days, 1)
    rows["daily_out"] = rows["out_qty"] / days
    rows["days_cover"] = pd.Series([round(c / o, 1) if o > 0 and c > 0 else None for c, o in zip(rows["current_qty"], rows["daily_out"])], index=rows.index, dtype=object)
    rows["moved"] = rows["lines"] > 0
    rows["status"] = rows.apply(lambda r: _status(r["current_qty"], r["days_cover"], bool(r["moved"]), r["opening_qty"]), axis=1)
    rows["last_movement"] = [last.get((ic, wh)) or (lm.strftime("%Y-%m-%d") if pd.notna(lm) else None) for ic, wh, lm in zip(rows["item_code"], rows["warehouse"], rows["last_in_range"])]
    rows["idle_days"] = pd.Series([(today - pd.Timestamp(d).date()).days if d else None for d in rows["last_movement"]], index=rows.index, dtype=object)
    rows["wh_label"] = rows["warehouse"].map(outlet_label)
    rows = rows.sort_values(["current_value", "in_value"], ascending=False)

    items = [{
        "item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group, "warehouse": r.wh_label, "uom": r.uom,
        "opening_qty": _r(r.opening_qty, 3), "in_qty": _r(r.in_qty, 3), "out_qty": _r(r.out_qty, 3), "closing_qty": _r(r.closing_qty, 3),
        "current_qty": _r(r.current_qty, 3), "opening_value": _r(r.opening_value), "in_value": _r(r.in_value), "out_value": _r(r.out_value),
        "closing_value": _r(r.closing_value), "current_value": _r(r.current_value), "rate": _r(r.current_rate),
        "lines": int(r.lines), "daily_out": _r(r.daily_out, 3), "days_cover": r.days_cover, "last_movement": r.last_movement,
        "idle_days": int(r.idle_days) if r.idle_days is not None else None, "status": r.status,
    } for r in rows.itertuples()]

    # movement kinds and the day-by-day line (range only)
    by_kind: list[dict[str, Any]] = []
    daily: list[dict[str, Any]] = []
    entries: list[dict[str, Any]] = []
    opening_total = float(rows["opening_value"].sum())
    if not in_range.empty:
        k = in_range.assign(in_value=in_range["value"].clip(lower=0), out_value=(-in_range["value"]).clip(lower=0),
                            in_qty=in_range["qty"].clip(lower=0), out_qty=(-in_range["qty"]).clip(lower=0))
        g = k.groupby("voucher_type", as_index=False).agg(in_value=("in_value", "sum"), out_value=("out_value", "sum"), in_qty=("in_qty", "sum"), out_qty=("out_qty", "sum"),
                                                          entries=("voucher_no", "nunique"), lines=("qty", "size"), items=("item_code", "nunique"))
        g["gross"] = g["in_value"] + g["out_value"]
        by_kind = [{"kind": r.voucher_type, "in_value": _r(r.in_value), "out_value": _r(r.out_value), "net_value": _r(r.in_value - r.out_value),
                    "in_qty": _r(r.in_qty, 3), "out_qty": _r(r.out_qty, 3), "entries": int(r.entries), "lines": int(r.lines), "items": int(r.items)}
                   for r in g.sort_values("gross", ascending=False).itertuples()]
        period = k["date"].dt.to_period("M").dt.start_time if rng.granularity == "month" else k["date"].dt.normalize()
        dg = k.assign(period=period).groupby("period").agg(in_value=("in_value", "sum"), out_value=("out_value", "sum"), in_qty=("in_qty", "sum"), out_qty=("out_qty", "sum"),
                                                           entries=("voucher_no", "nunique"), lines=("qty", "size"))
        if rng.granularity == "day":
            dg = dg.reindex(pd.date_range(rng.start, rng.end, freq="D"), fill_value=0)
        running = opening_total
        for p, r in dg.iterrows():
            running += float(r["in_value"]) - float(r["out_value"])
            daily.append({"date": pd.Timestamp(p).strftime("%Y-%m-%d"), "in_value": _r(r["in_value"]), "out_value": _r(r["out_value"]), "net_value": _r(r["in_value"] - r["out_value"]),
                          "in_qty": _r(r["in_qty"], 3), "out_qty": _r(r["out_qty"], 3), "entries": int(r["entries"]), "lines": int(r["lines"]), "balance_value": _r(running)})
        e = in_range.sort_values(["date", "time"], ascending=[False, False])
        entries = [{"date": r.date.strftime("%Y-%m-%d"), "time": r.time, "kind": r.voucher_type, "voucher_no": r.voucher_no, "item_code": r.item_code, "item_name": r.item_name,
                    "item_group": r.item_group, "warehouse": outlet_label(r.warehouse), "uom": r.uom, "qty": _r(r.qty, 3), "qty_after": _r(r.qty_after, 3),
                    "rate": _r(r.rate), "value": _r(r.value)} for r in e.itertuples()]

    statuses = rows["status"].value_counts()
    summary = {
        "opening_value": _r(opening_total), "in_value": _r(rows["in_value"].sum()), "out_value": _r(rows["out_value"].sum()),
        "net_value": _r(rows["in_value"].sum() - rows["out_value"].sum()), "closing_value": _r(rows["closing_value"].sum()), "current_value": _r(rows["current_value"].sum()),
        "in_qty": _r(rows["in_qty"].sum(), 3), "out_qty": _r(rows["out_qty"].sum(), 3),
        "items": int(rows["item_code"].nunique()), "warehouses": int(rows["warehouse"].nunique()),
        "entries": int(in_range["voucher_no"].nunique()) if not in_range.empty else 0, "lines": int(len(in_range)),
        "low": int(statuses.get("low", 0)), "out": int(statuses.get("out", 0)), "idle": int(statuses.get("idle", 0)),
    }
    return {
        **empty, "summary": summary,
        "by_warehouse": _agg(rows, "wh_label", "warehouse"), "by_group": _agg(rows, "item_group", "item_group"),
        "by_kind": by_kind, "daily": daily, "items": items, "entries": entries,
    }
