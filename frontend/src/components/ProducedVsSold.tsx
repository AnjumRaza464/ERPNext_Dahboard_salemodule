"use client";

import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { fmtRange, num, pkr } from "@/lib/format";
import type { CostingProducedVsSold, ProducedSoldRow, Range } from "@/lib/types";
import Card from "./Card";
import ExportButtons from "./ExportButtons";
import TableFilter from "./TableFilter";
import ViewToggle from "./ViewToggle";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

type Show = "all" | "unsold" | "short";

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";

function throughTone(v: number | null): string {
  if (v === null) return "text-ink-3";
  if (v < 70) return "text-bad";
  if (v < 85) return "text-warn";
  return "text-ink-2";
}

/**
 * Per product: what was produced (plus bought in) against what was sold on bills in the same range.
 * A positive gap is stock that was made but not sold (still on the shelf, or wasted); a negative gap was sold out of earlier stock.
 */
export default function ProducedVsSold({ range, refreshKey, onRetry }: Props) {
  const q = useApi<CostingProducedVsSold>("/api/costing/produced-vs-sold", range, refreshKey, { limit: 0 });
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [show, setShow] = useState<Show>("all");
  const d = q.data;
  const t = d?.totals;
  const groups = Array.from(new Set((d?.items ?? []).map((r) => r.item_group))).sort();
  const needle = query.trim().toLowerCase();
  const rows = (d?.items ?? []).filter(
    (r) =>
      (!group || r.item_group === group) &&
      (!needle || r.item_name.toLowerCase().includes(needle) || r.item_code.toLowerCase().includes(needle)) &&
      (show === "all" || (show === "unsold" ? r.variance_qty > 0.0001 : r.variance_qty < -0.0001)),
  );

  const cols: CsvColumn<ProducedSoldRow>[] = [
    { key: "item_code", header: "Item code", value: (r) => r.item_code },
    { key: "item_name", header: "Product", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    { key: "produced_qty", header: "Produced qty", value: (r) => r.produced_qty },
    { key: "purchased_qty", header: "Bought-in qty", value: (r) => r.purchased_qty },
    { key: "available_qty", header: "Available qty", value: (r) => r.available_qty },
    { key: "sold_qty", header: "Sold qty", value: (r) => r.sold_qty },
    { key: "variance_qty", header: "Not sold qty", value: (r) => r.variance_qty },
    { key: "sell_through", header: "Sell-through %", value: (r) => r.sell_through_pct },
    { key: "avg_price", header: "Avg selling rate", value: (r) => r.avg_price },
    { key: "std_rate", header: "Standard rate", value: (r) => r.std_rate },
    { key: "sold_amount", header: "Sales (PKR)", value: (r) => r.sold_amount },
    { key: "produced_value", header: "Produced value (PKR)", value: (r) => r.produced_value },
    { key: "unsold_value", header: "Not sold value (PKR)", value: (r) => r.unsold_value },
  ];
  const onExport = (fmt: ExportFormat) => exportTable(fmt, `produced-vs-sold-${range.start}-${range.end}`, rows, cols);

  return (
    <Card
      title="Produced vs Sold"
      subtitle={
        t
          ? `${fmtRange(range.start, range.end)} · ${num(t.produced_qty)} produced + ${num(t.purchased_qty)} bought in vs ${num(t.sold_qty)} sold · sell-through ${t.sell_through_pct != null ? `${num(t.sell_through_pct, 1)}%` : "—"} · ${num(t.variance_qty)} qty not sold (about ${pkr(t.unsold_value)} at standard rate)`
          : undefined
      }
      source={d?.source}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={!!d && d.items.length === 0}
      emptyHint="No production entries or sales in this range."
      onRetry={onRetry}
      height={200}
      action={
        <div className="flex items-center gap-2">
          <ViewToggle value={show} options={[{ id: "all", label: "All" }, { id: "unsold", label: "Not sold" }, { id: "short", label: "Sold from old stock" }]} onChange={setShow} />
          {d && d.items.length > 0 && <ExportButtons onExport={onExport} />}
        </div>
      }
    >
      {d && (
        <div className="flex flex-col gap-2">
          {d.groups.length > 1 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
              {d.groups.map((g) => (
                <span key={g.item_group} className="tnum">
                  <span className="text-ink-2">{g.item_group}</span>: {num(g.produced_qty + g.purchased_qty)} in · {num(g.sold_qty)} sold · {pkr(g.sold_amount)}
                </span>
              ))}
            </div>
          )}
          <TableFilter query={query} onQuery={setQuery} group={group} onGroup={setGroup} groups={groups} shown={rows.length} total={d.items.length} placeholder="Search product or code…" />
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[900px] text-xs">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className={thead}>
                  <th className={th}>Product</th>
                  <th className={th}>Group</th>
                  <th className={`${th} text-right`}>Produced</th>
                  <th className={`${th} text-right`}>Bought in</th>
                  <th className={`${th} text-right`}>Sold</th>
                  <th className={`${th} text-right`}>Not sold</th>
                  <th className={`${th} text-right`}>Sell-through</th>
                  <th className={`${th} text-right`}>Avg rate</th>
                  <th className={`${th} text-right`}>Sales</th>
                  <th className={`${th} text-right`}>Not sold value</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {rows.map((r) => (
                  <tr key={r.item_code} className="border-b border-line/60">
                    <td className="py-1.5 text-ink" title={r.item_code}>{r.item_name}</td>
                    <td className="py-1.5 text-ink-3">{r.item_group}</td>
                    <td className={tdNum}>{r.produced_qty ? num(r.produced_qty, 1) : <span className="text-ink-3">—</span>} <span className="text-ink-3">{r.produced_qty ? r.uom : ""}</span></td>
                    <td className={tdNum}>{r.purchased_qty ? num(r.purchased_qty, 1) : <span className="text-ink-3">—</span>}</td>
                    <td className="py-1.5 text-right font-medium text-ink">{r.sold_qty ? num(r.sold_qty, 1) : <span className="font-normal text-ink-3">—</span>}</td>
                    <td
                      className={`py-1.5 text-right font-medium ${r.variance_qty > 0.0001 ? throughTone(r.sell_through_pct) : r.variance_qty < -0.0001 ? "text-accent" : "text-ink-3"}`}
                      title={r.variance_qty > 0 ? "produced or bought in this range but not sold in it" : r.variance_qty < 0 ? "sold more than was produced or bought in this range: sold out of earlier stock" : undefined}
                    >
                      {Math.abs(r.variance_qty) < 0.0001 ? "0" : num(r.variance_qty, 1)}
                    </td>
                    <td className={`py-1.5 text-right ${throughTone(r.sell_through_pct)}`}>{r.sell_through_pct === null ? "—" : `${num(r.sell_through_pct, 0)}%`}</td>
                    <td className={tdNum}>{r.avg_price ? pkr(r.avg_price) : "—"}</td>
                    <td className={tdNum}>{r.sold_amount ? pkr(r.sold_amount) : "—"}</td>
                    <td className={tdNum}>{r.unsold_value ? pkr(r.unsold_value) : <span className="text-ink-3">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-ink-3">
            Quantities in each product&apos;s stock unit. Produced comes from production (Repack) entries, bought in from purchase invoices, sold from bills. Not sold = produced + bought in − sold:
            a positive number is stock still on the shelf or wasted, a negative one (blue) was sold out of stock made before this range. Short ranges exaggerate both.
          </p>
        </div>
      )}
    </Card>
  );
}
