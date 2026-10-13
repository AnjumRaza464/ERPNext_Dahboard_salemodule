"use client";

import type { QueryState } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { fmtDate, fmtRange, num, pkr } from "@/lib/format";
import type { Range, StockKindRow, StockRollup, StockTracking } from "@/lib/types";
import Card from "./Card";
import ExportButtons from "./ExportButtons";
import KpiCard from "./KpiCard";

interface Props {
  q: QueryState<StockTracking>;
  range: Range;
  onRetry: () => void;
}

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";

type WhRow = StockRollup & { warehouse: string };

/** Stock position for the range: opening -> in -> out -> closing, where it sits now, and the warehouse / movement-type breakdowns. */
export default function StockOverview({ q, range, onRetry }: Props) {
  const d = q.data;
  const s = d?.summary;
  const tile = { loading: q.loading, refreshing: q.refreshing, error: !!q.error };
  const alerts = s ? s.low + s.out : 0;

  const whCols: CsvColumn<WhRow>[] = [
    { key: "warehouse", header: "Warehouse", value: (r) => r.warehouse },
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
  const kindCols: CsvColumn<StockKindRow>[] = [
    { key: "kind", header: "Movement", value: (r) => r.kind },
    { key: "entries", header: "Entries", value: (r) => r.entries },
    { key: "lines", header: "Lines", value: (r) => r.lines },
    { key: "items", header: "Items", value: (r) => r.items },
    { key: "in_qty", header: "In qty", value: (r) => r.in_qty },
    { key: "out_qty", header: "Out qty", value: (r) => r.out_qty },
    { key: "in_value", header: "In (PKR)", value: (r) => r.in_value },
    { key: "out_value", header: "Out (PKR)", value: (r) => r.out_value },
    { key: "net_value", header: "Net (PKR)", value: (r) => r.net_value },
  ];
  const stem = `${range.start}-${range.end}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Opening stock" value={pkr(s?.opening_value)} sub={`on ${fmtDate(range.start)}`} {...tile} />
        <KpiCard label="Stock in" value={pkr(s?.in_value)} sub={s ? `${num(s.in_qty)} units · ${num(s.entries)} entries` : undefined} {...tile} />
        <KpiCard label="Stock out" value={pkr(s?.out_value)} sub={s ? `${num(s.out_qty)} units` : undefined} {...tile} />
        <KpiCard label="Closing stock" value={pkr(s?.closing_value)} sub={s ? `on ${fmtDate(range.end)} · net ${pkr(s.net_value, { sign: true })}` : undefined} {...tile} />
        <KpiCard label="Stock now" value={pkr(s?.current_value)} sub={d ? `as of ${fmtDate(d.as_of)} · ${num(s?.items)} items in ${num(s?.warehouses)} warehouses` : undefined} {...tile} />
        <KpiCard label="Needs attention" value={s ? num(alerts) : "—"} sub={s ? `${num(s.low)} running low · ${num(s.out)} out of stock · ${num(s.idle)} idle` : undefined} {...tile} />
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <Card
          title="Stock by Warehouse"
          subtitle={d ? `${fmtRange(range.start, range.end)} · opening, movement and closing value per warehouse · "Now" is today's balance` : undefined}
          source={d?.source}
          loading={q.loading}
          refreshing={q.refreshing}
          error={q.error}
          empty={!!d && d.by_warehouse.length === 0}
          emptyHint="No stock ledger postings or balances were found."
          onRetry={onRetry}
          height={160}
          className="xl:col-span-3"
          action={d && d.by_warehouse.length > 0 ? <ExportButtons onExport={(f: ExportFormat) => exportTable(f, `stock-by-warehouse-${stem}`, d.by_warehouse, whCols)} /> : undefined}
        >
          {d && (
            <div className="overflow-auto">
              <table className="w-full min-w-[720px] text-xs">
                <thead>
                  <tr className={thead}>
                    <th className={th}>Warehouse</th>
                    <th className={`${th} text-right`}>Items</th>
                    <th className={`${th} text-right`}>Opening</th>
                    <th className={`${th} text-right`}>In</th>
                    <th className={`${th} text-right`}>Out</th>
                    <th className={`${th} text-right`}>Closing</th>
                    <th className={`${th} text-right`}>Now</th>
                    <th className={`${th} text-right`}>Low / Out</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {d.by_warehouse.map((r) => (
                    <tr key={r.warehouse} className="border-b border-line/60">
                      <td className="py-1.5 font-medium text-ink">{r.warehouse}</td>
                      <td className={tdNum}>{num(r.items)}</td>
                      <td className={tdNum}>{pkr(r.opening_value)}</td>
                      <td className="py-1.5 text-right text-good">{pkr(r.in_value)}</td>
                      <td className="py-1.5 text-right text-bad">{pkr(r.out_value)}</td>
                      <td className="py-1.5 text-right font-medium text-ink">{pkr(r.closing_value)}</td>
                      <td className={tdNum}>{pkr(r.current_value)}</td>
                      <td className={tdNum}>
                        <span className={r.low ? "text-warn" : "text-ink-3"}>{num(r.low)}</span> / <span className={r.out ? "text-bad" : "text-ink-3"}>{num(r.out)}</span>
                      </td>
                    </tr>
                  ))}
                  {s && (
                    <tr className="font-semibold text-ink">
                      <td className="py-1.5">Total</td>
                      <td className="py-1.5 text-right">{num(s.items)}</td>
                      <td className="py-1.5 text-right">{pkr(s.opening_value)}</td>
                      <td className="py-1.5 text-right text-good">{pkr(s.in_value)}</td>
                      <td className="py-1.5 text-right text-bad">{pkr(s.out_value)}</td>
                      <td className="py-1.5 text-right">{pkr(s.closing_value)}</td>
                      <td className="py-1.5 text-right">{pkr(s.current_value)}</td>
                      <td className="py-1.5 text-right">
                        {num(s.low)} / {num(s.out)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Movement by Type"
          subtitle={d ? "What moved the stock: purchases, transfers between warehouses, production (Repack), sales and stock counts" : undefined}
          source="stock_entry"
          loading={q.loading}
          refreshing={q.refreshing}
          error={q.error}
          empty={!!d && d.by_kind.length === 0}
          emptyHint="Nothing was posted to the stock ledger in this range."
          onRetry={onRetry}
          height={160}
          className="xl:col-span-2"
          action={d && d.by_kind.length > 0 ? <ExportButtons onExport={(f: ExportFormat) => exportTable(f, `stock-movement-types-${stem}`, d.by_kind, kindCols)} /> : undefined}
        >
          {d && (
            <div className="overflow-auto">
              <table className="w-full min-w-[420px] text-xs">
                <thead>
                  <tr className={thead}>
                    <th className={th}>Movement</th>
                    <th className={`${th} text-right`}>Entries</th>
                    <th className={`${th} text-right`}>In</th>
                    <th className={`${th} text-right`}>Out</th>
                    <th className={`${th} text-right`}>Net</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {d.by_kind.map((r) => (
                    <tr key={r.kind} className="border-b border-line/60">
                      <td className="py-1.5 font-medium text-ink" title={`${num(r.lines)} lines · ${num(r.items)} items · in ${num(r.in_qty)} / out ${num(r.out_qty)} units`}>
                        {r.kind}
                      </td>
                      <td className={tdNum}>{num(r.entries)}</td>
                      <td className="py-1.5 text-right text-good">{pkr(r.in_value)}</td>
                      <td className="py-1.5 text-right text-bad">{pkr(r.out_value)}</td>
                      <td className={`py-1.5 text-right font-medium ${r.net_value > 0 ? "text-good" : r.net_value < 0 ? "text-bad" : "text-ink-3"}`}>{pkr(r.net_value, { sign: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
