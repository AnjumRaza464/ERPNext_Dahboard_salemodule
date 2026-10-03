"use client";

import { useApi } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { fmtDate, num, pkr } from "@/lib/format";
import type { AdjustmentRow, CostingAdjustments, Range } from "@/lib/types";
import Card from "./Card";
import ExportButtons from "./ExportButtons";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";

/** Stock Reconciliation postings in the range: stock value added or written off by a count, per item and warehouse. */
export default function StockAdjustments({ range, refreshKey, onRetry }: Props) {
  const q = useApi<CostingAdjustments>("/api/costing/adjustments", range, refreshKey);
  const d = q.data;
  const cols: CsvColumn<AdjustmentRow>[] = [
    { key: "date", header: "Date", value: (r) => r.date },
    { key: "voucher", header: "Reconciliation", value: (r) => r.voucher },
    { key: "item_code", header: "Item code", value: (r) => r.item_code },
    { key: "item_name", header: "Item", value: (r) => r.item_name },
    { key: "item_group", header: "Group", value: (r) => r.item_group },
    { key: "warehouse", header: "Warehouse", value: (r) => r.warehouse },
    { key: "qty_after", header: "Qty after count", value: (r) => r.qty_after },
    { key: "uom", header: "UOM", value: (r) => r.uom },
    { key: "rate_after", header: "Valuation rate after", value: (r) => r.rate_after },
    { key: "value_change", header: "Value change (PKR)", value: (r) => r.value_change },
  ];
  const onExport = (fmt: ExportFormat) => d && exportTable(fmt, `stock-adjustments-${range.start}-${range.end}`, d.items, cols);

  return (
    <Card
      title="Stock Adjustments"
      subtitle={
        d
          ? d.lines
            ? `${num(d.vouchers)} stock reconciliation${d.vouchers === 1 ? "" : "s"} · net ${pkr(d.net_value, { sign: true })} · added ${pkr(d.increase)} · written off ${pkr(Math.abs(d.decrease))} · ${d.by_group.map((g) => `${g.item_group} ${pkr(g.value, { sign: true })}`).join(" · ")}`
            : "Stock value changed by a count (Stock Reconciliation), not by buying, issuing or producing"
          : undefined
      }
      source={d?.source}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={!!d && d.lines === 0}
      emptyHint="No stock reconciliation was posted in this range."
      onRetry={onRetry}
      height={120}
      action={d && d.lines > 0 ? <ExportButtons onExport={onExport} /> : undefined}
    >
      {d && (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className={thead}>
                <th className={th}>Date</th>
                <th className={th}>Reconciliation</th>
                <th className={th}>Item</th>
                <th className={th}>Group</th>
                <th className={th}>Warehouse</th>
                <th className={`${th} text-right`}>Qty after count</th>
                <th className={`${th} text-right`}>Rate after</th>
                <th className={`${th} text-right`}>Value change</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {d.items.map((r, i) => (
                <tr key={`${r.voucher}-${r.item_code}-${r.warehouse}-${i}`} className="border-b border-line/60">
                  <td className="whitespace-nowrap py-1.5 text-ink">{fmtDate(r.date)}</td>
                  <td className="py-1.5 text-ink-2">{r.voucher}</td>
                  <td className="py-1.5 text-ink" title={r.item_code}>{r.item_name}</td>
                  <td className="py-1.5 text-ink-3">{r.item_group}</td>
                  <td className="py-1.5 text-ink-2">{r.warehouse}</td>
                  <td className={tdNum}>{num(r.qty_after, 2)} <span className="text-ink-3">{r.uom}</span></td>
                  <td className={tdNum}>{pkr(r.rate_after, { decimals: true })}</td>
                  <td className={`py-1.5 text-right font-medium ${r.value_change > 0 ? "text-good" : r.value_change < 0 ? "text-bad" : "text-ink-3"}`}>{pkr(r.value_change, { sign: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
