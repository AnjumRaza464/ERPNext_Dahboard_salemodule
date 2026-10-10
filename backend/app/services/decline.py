"""Why did sales go down? The selected range against the previous same-length window, broken into the
factors an owner can act on, each with an estimated PKR impact so they can be ranked:

* traffic      - fewer bills (customers), at the previous average bill
* basket       - a smaller average bill, on the current number of bills
* trading_days - fewer days with bills keyed in (closed, or entries not posted yet)
* stock_out    - products that sold in the comparison period but not at all now, and are not at the outlet
* item_decline - products still selling, but less (with the same-days-last-week and last-month view per item)
* discounts    - more discounts and returns than before

The impacts are estimates that overlap (fewer trading days also means fewer bills), so they are shown as a
ranked list, not summed. Figures come from POS bills; outlet stock from Bin; "produced" from Repack entries.
"""
from __future__ import annotations

import asyncio
from datetime import date
from typing import Any

import pandas as pd

from ..dates import DateRange
from . import costing, sales


def _month_back(rng: DateRange) -> DateRange:
    s = (pd.Timestamp(rng.start) - pd.DateOffset(months=1)).date()
    e = (pd.Timestamp(rng.end) - pd.DateOffset(months=1)).date()
    return DateRange(s, e)


async def _totals(rng: DateRange, refresh: bool = False) -> dict[str, Any]:
    daily = sales._daily(await sales._check_days(rng, refresh), rng)
    net = float(daily["net"].sum()) if not daily.empty else 0.0
    checks = int(daily["checks"].sum()) if not daily.empty else 0
    active = int((daily["checks"] > 0).sum()) if not daily.empty else 0
    return {
        "net": round(net, 2), "checks": checks, "avg_check": round(net / checks, 2) if checks else 0.0,
        "qty": round(float(daily["qty"].sum()), 3) if not daily.empty else 0.0,
        "active_days": active, "calendar_days": rng.days,
        "avg_per_active_day": round(net / active, 2) if active else 0.0,
        "discounts": round(float(daily["discounts"].sum()), 2) if not daily.empty else 0.0,
        "returns": round(abs(float(daily["returns_total"].sum())), 2) if not daily.empty else 0.0,
        "return_count": int(daily["return_count"].sum()) if not daily.empty else 0,
    }


def _pct(cur: float, prev: float) -> float | None:
    return round((cur - prev) / abs(prev) * 100, 1) if prev else None


def _items_map(df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    if df.empty:
        return {}
    return {r.item_code: {"name": r.item_name, "group": r.item_group, "qty": float(r.qty), "amount": float(r.amount)} for r in df.itertuples()}


async def factors(rng: DateRange, limit: int = 12, refresh: bool = False) -> dict[str, Any]:
    prev, lw, lm = rng.previous(), rng.shift(-7), _month_back(rng)
    (cur_t, prev_t, lw_t, lm_t, cur_i, prev_i, lw_i, lm_i, st, se) = await asyncio.gather(
        _totals(rng, refresh), _totals(prev), _totals(lw), _totals(lm),
        sales._item_frame(rng, refresh), sales._item_frame(prev), sales._item_frame(lw), sales._item_frame(lm),
        costing._stock_frame(refresh), costing._production_frame(rng, refresh),
    )
    ci, pi, li, mi = _items_map(cur_i), _items_map(prev_i), _items_map(lw_i), _items_map(lm_i)

    outlet: dict[str, float] = {}
    if not st.empty:
        at_outlet = st[st["warehouse"].map(costing.outlet_label).str.contains("outlet", case=False)]
        outlet = {str(k): float(v) for k, v in at_outlet.groupby("item_code")["qty"].sum().items()}
    produced: dict[str, float] = {}
    if not se.empty:
        made = se[se["kind"] == "produced"]
        produced = {str(k): float(v) for k, v in made.groupby("item_code")["qty"].sum().items()}

    decline = cur_t["net"] - prev_t["net"]
    comparisons = {
        "previous": {"range": prev.as_dict(), "net": prev_t["net"], "checks": prev_t["checks"], "avg_check": prev_t["avg_check"],
                     "delta_abs": round(decline, 2), "delta_pct": _pct(cur_t["net"], prev_t["net"])},
        "last_week": {"range": lw.as_dict(), "net": lw_t["net"], "checks": lw_t["checks"], "avg_check": lw_t["avg_check"],
                      "delta_abs": round(cur_t["net"] - lw_t["net"], 2), "delta_pct": _pct(cur_t["net"], lw_t["net"])},
        "last_month": {"range": lm.as_dict(), "net": lm_t["net"], "checks": lm_t["checks"], "avg_check": lm_t["avg_check"],
                       "delta_abs": round(cur_t["net"] - lm_t["net"], 2), "delta_pct": _pct(cur_t["net"], lm_t["net"])},
    }

    out: list[dict[str, Any]] = []

    # 1. traffic: fewer bills
    traffic = (cur_t["checks"] - prev_t["checks"]) * prev_t["avg_check"]
    out.append({
        "key": "traffic", "title": "Kam customer aaye (bills kam)", "impact": round(traffic, 2),
        "metric": {"label": "Bills", "current": cur_t["checks"], "previous": prev_t["checks"], "last_week": lw_t["checks"], "last_month": lm_t["checks"],
                   "delta_pct": _pct(cur_t["checks"], prev_t["checks"])},
        "detail": f"{cur_t['checks']} bills vs {prev_t['checks']} pehle · har bill ka pehla average Rs {prev_t['avg_check']:,.0f} laga kar",
        "items": [],
    })

    # 2. basket: smaller average bill
    basket = (cur_t["avg_check"] - prev_t["avg_check"]) * cur_t["checks"]
    out.append({
        "key": "basket", "title": "Har customer ne kam khareeda (average bill)", "impact": round(basket, 2),
        "metric": {"label": "Average bill", "current": cur_t["avg_check"], "previous": prev_t["avg_check"], "last_week": lw_t["avg_check"], "last_month": lm_t["avg_check"],
                   "delta_pct": _pct(cur_t["avg_check"], prev_t["avg_check"])},
        "detail": f"Rs {cur_t['avg_check']:,.0f} per bill vs Rs {prev_t['avg_check']:,.0f} pehle · {cur_t['checks']} bills par",
        "items": [],
    })

    # 3. trading days: fewer days with bills
    days_diff = cur_t["active_days"] - prev_t["active_days"]
    out.append({
        "key": "trading_days", "title": "Kam din bills enter hue", "impact": round(days_diff * prev_t["avg_per_active_day"], 2),
        "metric": {"label": "Trading din", "current": cur_t["active_days"], "previous": prev_t["active_days"], "last_week": lw_t["active_days"], "last_month": lm_t["active_days"],
                   "delta_pct": _pct(cur_t["active_days"], prev_t["active_days"])},
        "detail": f"{cur_t['active_days']} of {cur_t['calendar_days']} din vs {prev_t['active_days']} pehle · Rs {prev_t['avg_per_active_day']:,.0f} per din",
        "items": [],
    })

    # 4. stock-out: sold before, nothing now, and not on the outlet shelf
    missing = []
    for code, p in pi.items():
        if p["amount"] <= 0 or ci.get(code, {}).get("amount", 0) > 0:
            continue
        stock = outlet.get(code, 0.0)
        made = produced.get(code, 0.0)
        missing.append({
            "item_code": code, "item_name": p["name"], "item_group": p["group"],
            "prev_qty": round(p["qty"], 2), "prev_amount": round(p["amount"], 2),
            "last_week_amount": round(li.get(code, {}).get("amount", 0.0), 2), "last_month_amount": round(mi.get(code, {}).get("amount", 0.0), 2),
            "outlet_stock": round(stock, 2), "produced_qty": round(made, 2),
            "reason": "outlet par stock nahi, bana bhi nahi" if stock <= 0 and made <= 0 else ("outlet par stock nahi" if stock <= 0 else "outlet par pada hai, bika nahi"),
        })
    missing.sort(key=lambda x: -x["prev_amount"])
    unavailable = [m for m in missing if m["outlet_stock"] <= 0]
    out.append({
        "key": "stock_out", "title": "Items outlet par available nahi thay", "impact": round(-sum(m["prev_amount"] for m in unavailable), 2),
        "metric": {"label": "Items missing", "current": len(unavailable), "previous": None, "last_week": None, "last_month": None, "delta_pct": None},
        "detail": f"{len(unavailable)} items jo pehle bike, is period mein bilkul nahi bike aur outlet par stock bhi nahi" + (f" · {len(missing) - len(unavailable)} aur items pade hain lekin bike nahi" if len(missing) > len(unavailable) else ""),
        "items": missing[:limit],
    })

    # 5. item decline: still selling, but less
    declining = []
    for code, c in ci.items():
        p = pi.get(code)
        if not p or p["amount"] <= 0 or c["amount"] >= p["amount"]:
            continue
        declining.append({
            "item_code": code, "item_name": c["name"], "item_group": c["group"],
            "qty": round(c["qty"], 2), "amount": round(c["amount"], 2), "prev_qty": round(p["qty"], 2), "prev_amount": round(p["amount"], 2),
            "delta_abs": round(c["amount"] - p["amount"], 2), "delta_pct": _pct(c["amount"], p["amount"]),
            "last_week_amount": round(li.get(code, {}).get("amount", 0.0), 2), "vs_last_week_pct": _pct(c["amount"], li.get(code, {}).get("amount", 0.0)),
            "last_month_amount": round(mi.get(code, {}).get("amount", 0.0), 2), "vs_last_month_pct": _pct(c["amount"], mi.get(code, {}).get("amount", 0.0)),
            "outlet_stock": round(outlet.get(code, 0.0), 2),
        })
    declining.sort(key=lambda x: x["delta_abs"])
    out.append({
        "key": "item_decline", "title": "Items pehle se kam bike", "impact": round(sum(d["delta_abs"] for d in declining), 2),
        "metric": {"label": "Items down", "current": len(declining), "previous": None, "last_week": None, "last_month": None, "delta_pct": None},
        "detail": f"{len(declining)} items ki sale giri · top {min(limit, len(declining))} neeche, pichle hafte aur pichle mahine ke unhi dinon ke saath",
        "items": declining[:limit],
    })

    # 6. discounts and returns
    leak_cur = cur_t["discounts"] + cur_t["returns"]
    leak_prev = prev_t["discounts"] + prev_t["returns"]
    out.append({
        "key": "discounts", "title": "Discount aur returns barhe", "impact": round(-(leak_cur - leak_prev), 2),
        "metric": {"label": "Discounts + returns", "current": round(leak_cur, 2), "previous": round(leak_prev, 2),
                   "last_week": round(lw_t["discounts"] + lw_t["returns"], 2), "last_month": round(lm_t["discounts"] + lm_t["returns"], 2), "delta_pct": _pct(leak_cur, leak_prev)},
        "detail": f"discounts Rs {cur_t['discounts']:,.0f} + returns Rs {cur_t['returns']:,.0f} ({cur_t['return_count']} bills) vs Rs {leak_prev:,.0f} pehle",
        "items": [],
    })

    # gains, so the board is honest when something went up
    gains = [
        {"item_code": code, "item_name": c["name"], "item_group": c["group"], "amount": round(c["amount"], 2),
         "prev_amount": round(pi.get(code, {}).get("amount", 0.0), 2), "delta_abs": round(c["amount"] - pi.get(code, {}).get("amount", 0.0), 2)}
        for code, c in ci.items() if c["amount"] > pi.get(code, {}).get("amount", 0.0)
    ]
    gains.sort(key=lambda x: -x["delta_abs"])

    total_neg = sum(-f["impact"] for f in out if f["impact"] < 0)
    for f in out:
        f["share_pct"] = round(-f["impact"] / total_neg * 100, 1) if f["impact"] < 0 and total_neg else 0.0
        f["direction"] = "down" if f["impact"] < 0 else ("up" if f["impact"] > 0 else "flat")
    ranked = sorted([f for f in out if f["impact"] < 0], key=lambda f: f["impact"]) + sorted([f for f in out if f["impact"] >= 0], key=lambda f: -f["impact"])

    return {
        "source": "pos_invoice", "range": rng.as_dict(),
        "current": cur_t, "comparisons": comparisons,
        "decline_abs": round(decline, 2), "decline_pct": _pct(cur_t["net"], prev_t["net"]),
        "factors": ranked,
        "gains": gains[:limit], "gains_total": round(sum(g["delta_abs"] for g in gains), 2),
    }


# ------------------------------------------------------------------ cost increase factors

async def _cost_totals(rng: DateRange, refresh: bool = False) -> dict[str, Any]:
    se, net = await asyncio.gather(costing._production_frame(rng, refresh), costing._net_sales(rng, refresh))
    consumed = se[se["kind"] == "consumed"] if not se.empty else se
    produced = se[se["kind"] == "produced"] if not se.empty else se
    c, p = costing._sum(consumed, "amount"), costing._sum(produced, "amount")
    return {"net": round(net, 2), "consumed": round(c, 2), "produced": round(p, 2),
            "cost_pct": round(c / net * 100, 1) if net else None,
            "material_per_100_output": round(c / p * 100, 1) if p else None, "frame": consumed}


def _material_rows(df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    if df.empty:
        return {}
    g = df.groupby("item_code").agg(name=("item_name", "first"), group=("item_group", "first"), uom=("uom", "first"), qty=("qty", "sum"), amount=("amount", "sum"))
    return {str(k): {"name": r["name"], "group": r["group"], "uom": r["uom"], "qty": float(r["qty"]), "amount": float(r["amount"]),
                     "rate": float(r["amount"]) / float(r["qty"]) if r["qty"] else 0.0} for k, r in g.iterrows()}


async def cost_factors(rng: DateRange, limit: int = 12, refresh: bool = False) -> dict[str, Any]:
    """Why material cost % of sales moved vs the previous window, as ranked factors with PKR and percentage-point impact."""
    prev, lw, lm = rng.previous(), rng.shift(-7), _month_back(rng)
    cur, before, lw_t, lm_t, pvs_cur, pvs_prev, adj_cur, adj_prev = await asyncio.gather(
        _cost_totals(rng, refresh), _cost_totals(prev), _cost_totals(lw), _cost_totals(lm),
        costing.produced_vs_sold(rng, 0, refresh), costing.produced_vs_sold(prev, 0),
        costing.adjustments(rng, refresh), costing.adjustments(prev),
    )
    cm, pm = _material_rows(cur.pop("frame")), _material_rows(before.pop("frame"))
    lw_t.pop("frame", None)
    lm_t.pop("frame", None)
    S, S0, C, C0 = cur["net"], before["net"], cur["consumed"], before["consumed"]
    pct_now, pct_prev = cur["cost_pct"], before["cost_pct"]
    change_pts = round(pct_now - pct_prev, 1) if pct_now is not None and pct_prev is not None else None

    def pts(pkr: float) -> float | None:
        return round(pkr / S * 100, 1) if S else None

    # rate vs usage per material (at the valuation rates production was booked at)
    rate_rows: list[dict[str, Any]] = []
    usage_rows: list[dict[str, Any]] = []
    rate_effect = usage_effect = 0.0
    for code, c in cm.items():
        p = pm.get(code)
        if p and p["qty"] > 0 and c["qty"] > 0:
            r_eff = (c["rate"] - p["rate"]) * c["qty"]
            u_eff = (c["qty"] - p["qty"]) * p["rate"]
            rate_effect += r_eff
            usage_effect += u_eff
            rate_rows.append({"item_code": code, "item_name": c["name"], "item_group": c["group"], "uom": c["uom"], "qty": round(c["qty"], 2),
                              "rate": round(c["rate"], 2), "prev_rate": round(p["rate"], 2), "rate_change_pct": _pct(c["rate"], p["rate"]), "effect": round(r_eff, 2)})
            usage_rows.append({"item_code": code, "item_name": c["name"], "item_group": c["group"], "uom": c["uom"], "qty": round(c["qty"], 2), "prev_qty": round(p["qty"], 2),
                               "qty_change_pct": _pct(c["qty"], p["qty"]), "amount": round(c["amount"], 2), "prev_amount": round(p["amount"], 2), "effect": round(u_eff, 2)})
        elif not p:
            usage_effect += c["amount"]
            usage_rows.append({"item_code": code, "item_name": c["name"], "item_group": c["group"], "uom": c["uom"], "qty": round(c["qty"], 2), "prev_qty": 0.0,
                               "qty_change_pct": None, "amount": round(c["amount"], 2), "prev_amount": 0.0, "effect": round(c["amount"], 2)})
    rate_rows.sort(key=lambda x: -x["effect"])
    usage_rows.sort(key=lambda x: -x["effect"])

    # how much of the usage change is just more output, and how much is more material per unit of output
    ratio_prev = C0 / before["produced"] if before["produced"] else None
    volume_effect = (cur["produced"] - before["produced"]) * ratio_prev if ratio_prev is not None else 0.0
    efficiency_effect = usage_effect - volume_effect

    # the sales side: cost % climbs when sales fall faster than material
    sales_effect_pts = round((C / S - C / S0) * 100, 1) if S and S0 else None
    material_effect_pts = round((C / S0 - C0 / S0) * 100, 1) if S0 else None

    unsold_cur, unsold_prev = pvs_cur["totals"]["unsold_value"], pvs_prev["totals"]["unsold_value"]
    writeoff_cur, writeoff_prev = abs(adj_cur["decrease"]), abs(adj_prev["decrease"])
    mp_now, mp_prev = cur["material_per_100_output"] or 0, before["material_per_100_output"] or 0

    factors = [
        {"key": "rates", "title": "Material ke rates barhe", "impact": round(rate_effect, 2), "impact_pts": pts(rate_effect),
         "detail": f"{sum(1 for r in rate_rows if r['effect'] > 0)} materials mehenge hue, {sum(1 for r in rate_rows if r['effect'] < 0)} saste · usi quantity par net PKR {rate_effect:,.0f} ka asar",
         "metric": {"label": "Rate effect", "current": round(rate_effect, 2), "previous": None, "last_week": None, "last_month": None, "delta_pct": None},
         "items": rate_rows[:limit]},
        {"key": "efficiency", "title": "Per unit output zyada material laga", "impact": round(efficiency_effect, 2), "impact_pts": pts(efficiency_effect),
         "detail": f"PKR {mp_now:,.0f} material per PKR 100 output vs PKR {mp_prev:,.0f} pehle",
         "metric": {"label": "Material per 100 output", "current": cur["material_per_100_output"], "previous": before["material_per_100_output"],
                    "last_week": lw_t["material_per_100_output"], "last_month": lm_t["material_per_100_output"], "delta_pct": _pct(mp_now, mp_prev)},
         "items": usage_rows[:limit]},
        {"key": "sales", "title": "Sale giri, is liye cost % barha", "impact": round((sales_effect_pts or 0) / 100 * S, 2), "impact_pts": sales_effect_pts,
         "detail": f"net sales PKR {S:,.0f} vs PKR {S0:,.0f} pehle · usi material par cost % {(sales_effect_pts or 0):+.1f} pts",
         "metric": {"label": "Net sales", "current": S, "previous": S0, "last_week": lw_t["net"], "last_month": lm_t["net"], "delta_pct": _pct(S, S0)},
         "items": []},
        {"key": "waste", "title": "Bana lekin bika nahi (waste / unsold)", "impact": round(unsold_cur - unsold_prev, 2), "impact_pts": pts(unsold_cur - unsold_prev),
         "detail": f"PKR {unsold_cur:,.0f} ka maal bana ya khareeda jo bika nahi vs PKR {unsold_prev:,.0f} pehle",
         "metric": {"label": "Unsold value", "current": round(unsold_cur, 2), "previous": round(unsold_prev, 2), "last_week": None, "last_month": None, "delta_pct": _pct(unsold_cur, unsold_prev)},
         "items": []},
        {"key": "writeoffs", "title": "Stock write-off (reconciliation)", "impact": round(writeoff_cur - writeoff_prev, 2), "impact_pts": pts(writeoff_cur - writeoff_prev),
         "detail": f"PKR {writeoff_cur:,.0f} stock count mein kam nikla vs PKR {writeoff_prev:,.0f} pehle",
         "metric": {"label": "Written off", "current": round(writeoff_cur, 2), "previous": round(writeoff_prev, 2), "last_week": None, "last_month": None, "delta_pct": _pct(writeoff_cur, writeoff_prev)},
         "items": []},
        {"key": "volume", "title": "Production zyada hui (normal asar)", "impact": round(volume_effect, 2), "impact_pts": pts(volume_effect),
         "detail": f"finished goods PKR {cur['produced']:,.0f} vs PKR {before['produced']:,.0f} pehle · pichle material ratio par",
         "metric": {"label": "Produced", "current": cur["produced"], "previous": before["produced"], "last_week": lw_t["produced"], "last_month": lm_t["produced"], "delta_pct": _pct(cur["produced"], before["produced"])},
         "items": []},
    ]
    total_up = sum(f["impact"] for f in factors if f["impact"] > 0)
    for f in factors:
        f["share_pct"] = round(f["impact"] / total_up * 100, 1) if f["impact"] > 0 and total_up else 0.0
        f["direction"] = "up" if f["impact"] > 0 else ("down" if f["impact"] < 0 else "flat")
    ranked = sorted([f for f in factors if f["impact"] > 0], key=lambda f: -f["impact"]) + sorted([f for f in factors if f["impact"] <= 0], key=lambda f: f["impact"])
    cheaper = sorted([r for r in rate_rows if r["effect"] < 0], key=lambda x: x["effect"])[:limit]

    def cmp(rng_: DateRange, t: dict[str, Any]) -> dict[str, Any]:
        return {"range": rng_.as_dict(), "net": t["net"], "consumed": t["consumed"], "cost_pct": t["cost_pct"],
                "delta_pts": round(pct_now - t["cost_pct"], 1) if pct_now is not None and t["cost_pct"] is not None else None}

    return {
        "source": "stock_entry", "range": rng.as_dict(), "current": cur, "previous": before,
        "comparisons": {"previous": cmp(prev, before), "last_week": cmp(lw, lw_t), "last_month": cmp(lm, lm_t)},
        "change_pts": change_pts, "material_effect_pts": material_effect_pts, "sales_effect_pts": sales_effect_pts,
        "factors": ranked, "cheaper": cheaper, "cheaper_total": round(sum(r["effect"] for r in cheaper), 2),
    }
