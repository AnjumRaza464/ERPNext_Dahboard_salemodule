"use client";

import { useState } from "react";
import type { QueryState } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { fmtDate, fmtPeriod, fmtRange, num, pkr } from "@/lib/format";
import type { Range, StockDay, StockRollup, StockTracking } from "@/lib/types";
import Card from "./Card";
import StackedColumns from "./charts/StackedColumns";
import ExportButtons from "./ExportButtons";
import ViewToggle from "./ViewToggle";

interface Props {
  q: QueryState<StockTracking>;
  range: Range;
  onRetry: () => void;
}

type View = "daily" | "group";

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";

type GroupRow = StockRollup & { item_group: string };

/** Day-by-day stock movement (in vs out) with the running stock value, and the same movement per item group. */
export default function StockMovement({ q, range, onRetry }: Props) {
  const [view, setView] = useState<View>("daily");
  const d = q.data;
  const days = d?.daily ?? [];
  const chartRows = days.map((r) => ({ label: fmtPeriod(r.date, d?.granularity ?? "day"), In: r.in_value, Out: r.out_value }));
  const active = days.filter((r) => r.lines > 0).length;

  const dayCols: CsvColumn<StockDay>[] = [
    { key: "date", header: d?.granularity === "month" ? "Month" : "Date", value: (r) => r.date },
    { key: "entries", header: "Entries", value: (r) => r.entries },
    { key: "lines", header: "Lines", value: (r) => r.lines },
    { key: "in_qty", header: "In qty", value: (r) => r.in_qty },
    { key: "out_qty", header: "Out qty", value: (r) => r.out_qty },
    { key: "in_value", header: "In (PKR)", value: (r) => r.in_value },
    { key: "out_value", header: "Out (PKR)", value: (r) => r.out_value },
    { key: "net_value", header: "Net (PKR)", value: (r) => r.net_value },
    { key: "balance_value", header: "Stock value at close (PKR)", value: (r) => r.balance_value },
  ];
  const groupCols: CsvColumn<GroupRow>[] = [
    { key: "item_group", header: "Item group", value: (r) => r.item_group },
    { key: "items", header: "Items", value: (r) => r.items },
    { key: "opening_value", header: "Opening (PKR)", value: (r) => r.opening_value },
    { key: "in_value", header: "In (PKR)", value: (r) => r.in_value },
    { key: "out_value", header: "Out (PKR)", value: (r) => r.out_value },
    { key: "net_value", header: "Net (PKR)", value: (r) => r.net_value },
    { key: "closing_value", header: "Closing (PKR)", value: (r) => r.closing_value },
    { key: "current_value", header: "Now (PKR)", value: (r) => r.current_value },
    { key: "low", header: "Running low", value: (r) => r.low },
    { key: "out", header: "Out of stock", value: (r) => r.out },
  ];
  const onExport = (fmt: ExportFormat) => {
    if (!d) return;
    const stem = `${range.start}-${range.end}`;
    if (view === "daily") exportTable(fmt, `stock-movement-daily-${stem}`, days, dayCols);
    else exportTable(fmt, `stock-by-group-${stem}`, d.by_group, groupCols);
  };

  return (
    <Card
      title="Stock Movement"
      subtitle={
        d
          ? `${fmtRange(range.start, range.end)} · ${num(d.summary.entries)} entries on ${num(active)} ${d.granularity === "month" ? "months" : "days"} · in ${pkr(d.summary.in_value)} · out ${pkr(d.summary.out_value)} · stock value went from ${pkr(d.summary.opening_value)} to ${pkr(d.summary.closing_value)}`
          : undefined
      }
      source="stock_entry"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      empty={!!d && days.length === 0}
      emptyHint="Nothing was posted to the stock ledger in this range."
      onRetry={onRetry}
      height={300}
      action={
        d && days.length > 0 ? (
          <div className="flex items-center gap-2">
            <ViewToggle
              value={view}
              options={[
                { id: "daily", label: d.granularity === "month" ? "Month-wise" : "Day-wise" },
                { id: "group", label: "Item group" },
              ]}
              onChange={setView}
            />
            <ExportButtons onExport={onExport} />
          </div>
        ) : undefined
      }
    >
      {d && (
        <div className="flex flex-col gap-4">
          <StackedColumns rows={chartRows} keys={["In", "Out"]} stacked={false} height={220} tickEvery={chartRows.length > 40 ? 4 : chartRows.length > 20 ? 2 : 1} colors={["var(--good)", "var(--bad)"]} />
          <div className="max-h-[360px] overflow-auto">
            {view === "daily" ? (
              <table className="w-full min-w-[720px] text-xs">
                <thead className="sticky top-0 z-10 bg-surface">
                  <tr className={thead}>
                    <th className={th}>{d.granularity === "month" ? "Month" : "Date"}</th>
                    <th className={`${th} text-right`}>Entries</th>
                    <th className={`${th} text-right`}>In qty</th>
                    <th className={`${th} text-right`}>Out qty</th>
                    <th className={`${th} text-right`}>In</th>
                    <th className={`${th} text-right`}>Out</th>
                    <th className={`${th} text-right`}>Net</th>
                    <th className={`${th} text-right`}>Stock value at close</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {days.map((r) => (
                    <tr key={r.date} className={`border-b border-line/60 ${r.lines === 0 ? "text-ink-3" : ""}`}>
                      <td className="whitespace-nowrap py-1.5 text-ink">{d.granularity === "month" ? fmtPeriod(r.date, "month") : fmtDate(r.date)}</td>
                      <td className={tdNum}>{r.entries ? num(r.entries) : "—"}</td>
                      <td className={tdNum}>{num(r.in_qty)}</td>
                      <td className={tdNum}>{num(r.out_qty)}</td>
                      <td className={`py-1.5 text-right ${r.in_value ? "text-good" : "text-ink-3"}`}>{pkr(r.in_value)}</td>
                      <td className={`py-1.5 text-right ${r.out_value ? "text-bad" : "text-ink-3"}`}>{pkr(r.out_value)}</td>
                      <td className={`py-1.5 text-right font-medium ${r.net_value > 0 ? "text-good" : r.net_value < 0 ? "text-bad" : "text-ink-3"}`}>{pkr(r.net_value, { sign: true })}</td>
                      <td className="py-1.5 text-right font-medium text-ink">{pkr(r.balance_value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full min-w-[720px] text-xs">
                <thead className="sticky top-0 z-10 bg-surface">
                  <tr className={thead}>
                    <th className={th}>Item group</th>
                    <th className={`${th} text-right`}>Items</th>
                    <th className={`${th} text-right`}>Opening</th>
                    <th className={`${th} text-right`}>In</th>
                    <th className={`${th} text-right`}>Out</th>
                    <th className={`${th} text-right`}>Net</th>
                    <th className={`${th} text-right`}>Closing</th>
                    <th className={`${th} text-right`}>Now</th>
                    <th className={`${th} text-right`}>Low / Out</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {d.by_group.map((r) => (
                    <tr key={r.item_group} className="border-b border-line/60">
                      <td className="py-1.5 font-medium text-ink">{r.item_group}</td>
                      <td className={tdNum}>{num(r.items)}</td>
                      <td className={tdNum}>{pkr(r.opening_value)}</td>
                      <td className="py-1.5 text-right text-good">{pkr(r.in_value)}</td>
                      <td className="py-1.5 text-right text-bad">{pkr(r.out_value)}</td>
                      <td className={`py-1.5 text-right font-medium ${r.net_value > 0 ? "text-good" : r.net_value < 0 ? "text-bad" : "text-ink-3"}`}>{pkr(r.net_value, { sign: true })}</td>
                      <td className="py-1.5 text-right font-medium text-ink">{pkr(r.closing_value)}</td>
                      <td className={tdNum}>{pkr(r.current_value)}</td>
                      <td className={tdNum}>
                        <span className={r.low ? "text-warn" : "text-ink-3"}>{num(r.low)}</span> / <span className={r.out ? "text-bad" : "text-ink-3"}>{num(r.out)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
