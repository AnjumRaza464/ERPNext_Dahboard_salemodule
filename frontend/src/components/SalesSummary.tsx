"use client";

import { useApi, type QueryState } from "@/hooks/useApi";
import { exportTable, type CsvColumn, type ExportFormat } from "@/lib/csv";
import { downloadWorkbook } from "@/lib/excel";
import { fmtDate, fmtRange, num, pkr } from "@/lib/format";
import type { ItemGroupRow, ItemGroupSales, PaymentModes, Range, RunRate, SalesKpis, TopItem, TopItems } from "@/lib/types";
import Card from "./Card";
import DeltaText from "./DeltaText";
import ExportButtons from "./ExportButtons";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
  /** the same queries the KPI rows use, so the card follows the chosen comparison basis and target */
  kpis: QueryState<SalesKpis>;
  pace: QueryState<RunRate>;
  cmpLabel: string;
}

interface Tile {
  n: number;
  label: string;
  value: string;
  raw: number;
  prev: number | null;
  prevText: string | null;
  delta: number | null | undefined;
  lines: string[];
  color: string;
}

const th = "py-1.5 font-medium";
const thead = "border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3";
const tdNum = "py-1.5 text-right text-ink-2";
const TARGET_LABEL: Record<string, string> = { achieved: "target achieved", on_track: "on track", at_risk: "at risk", behind: "behind target" };

function Ratio({ label, value, note, tone = "text-ink" }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col gap-0.5 rounded-lg border border-line px-3 py-2">
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-3">{label}</span>
      <span className={`tnum truncate text-base font-semibold leading-tight ${tone}`} title={value}>{value}</span>
      {note && <span className="tnum text-[11px] text-ink-3">{note}</span>}
    </div>
  );
}

/**
 * The whole Sales tab on one card: six headline tiles against the comparison period, the ratios that matter
 * (discounts, returns, top product, top group, payment, data freshness), one line per item group and a recap.
 */
export default function SalesSummary({ range, refreshKey, onRetry, kpis, pace, cmpLabel }: Props) {
  const groups = useApi<ItemGroupSales>("/api/sales/by-item-group", range, refreshKey);
  const top = useApi<TopItems>("/api/sales/top-items", range, refreshKey, { limit: 10 });
  const modes = useApi<PaymentModes>("/api/sales/payment-modes", range, refreshKey);

  const k = kpis.data;
  const c = k?.current;
  const p = k?.previous;
  const dl = k?.delta_pct;
  const h = k?.health;
  const r = pace.data;
  const m = r?.month;
  const prevRange = k ? fmtRange(k.previous_range.start, k.previous_range.end) : "";
  const topItem = top.data?.items[0];
  const topGroup = groups.data?.groups[0];
  const topMode = modes.data?.modes[0];

  const tiles: Tile[] = c && p
    ? [
        { n: 1, label: "Net sales", value: pkr(c.net_sales), raw: c.net_sales, prev: p.net_sales, prevText: pkr(p.net_sales), delta: dl?.net_sales, color: "var(--series-1)",
          lines: [`gross ${pkr(c.gross_sales)}`, `discounts ${pkr(c.discounts)} · returns ${pkr(Math.abs(c.returns_total))}`] },
        { n: 2, label: "Bills", value: num(c.checks), raw: c.checks, prev: p.checks, prevText: num(p.checks), delta: dl?.checks, color: "var(--series-4)",
          lines: [`${num(c.checks_per_trading_day, 1)} bills per trading din`, `${num(c.active_days)} of ${num(h?.calendar_days ?? r?.calendar_days ?? c.active_days)} din had bills`] },
        { n: 3, label: "Average bill", value: pkr(c.avg_check), raw: c.avg_check, prev: p.avg_check, prevText: pkr(p.avg_check), delta: dl?.avg_check, color: "var(--series-2)",
          lines: [`${num(c.items_per_check, 1)} items per bill`, c.excluded_days.length ? `excl. ${c.excluded_days.length} bulk-entry din` : "net sales ÷ bills"] },
        { n: 4, label: "Quantity sold", value: num(c.total_qty), raw: c.total_qty, prev: p.total_qty, prevText: num(p.total_qty), delta: dl?.total_qty, color: "var(--series-3)",
          lines: [top.data ? `${num(top.data.distinct_items)} different products` : "products loading…", topItem ? `top: ${topItem.item_name}` : "no items sold"] },
        { n: 5, label: "Avg per trading day", value: pkr(r?.avg_per_active_day ?? c.avg_per_day), raw: r?.avg_per_active_day ?? c.avg_per_day, prev: p.avg_per_day, prevText: pkr(p.avg_per_day), delta: dl?.avg_per_day, color: "var(--series-5)",
          lines: [r?.best_day ? `best ${fmtDate(r.best_day.date)} · ${pkr(r.best_day.total)}` : "no bills in range", r?.worst_day ? `lowest ${fmtDate(r.worst_day.date)} · ${pkr(r.worst_day.total)}` : ""].filter(Boolean) },
        { n: 6, label: m ? `${m.label} so far` : "Month so far", value: pkr(m?.mtd), raw: m?.mtd ?? 0, prev: null, prevText: null, delta: null, color: "var(--series-6)",
          lines: m
            ? [
                m.is_complete ? "month complete" : `projected ${pkr(m.projected)} · ${num(m.remaining_trading_days)} trading din left`,
                m.target ? `target ${pkr(m.target.amount)} · ${num(m.target.attainment_pct, 1)}% · ${TARGET_LABEL[m.target.status] ?? m.target.status}` : "no monthly target set",
              ]
            : ["loading…"] },
      ]
    : [];

  const tileCols: CsvColumn<Tile>[] = [
    { key: "n", header: "No", value: (t) => t.n },
    { key: "label", header: "Figure", value: (t) => t.label },
    { key: "value", header: "This period", value: (t) => t.raw },
    { key: "prev", header: "Comparison period", value: (t) => t.prev },
    { key: "delta", header: "Change %", value: (t) => t.delta ?? null },
    { key: "detail", header: "Detail", value: (t) => t.lines.join(" · ") },
  ];
  const groupCols: CsvColumn<ItemGroupRow>[] = [
    { key: "item_group", header: "Item group", value: (g) => g.item_group },
    { key: "amount", header: "Sales (PKR)", value: (g) => g.amount },
    { key: "qty", header: "Qty", value: (g) => g.qty },
    { key: "items", header: "Products", value: (g) => g.items },
    { key: "share", header: "Share %", value: (g) => g.share_pct },
  ];
  const itemCols: CsvColumn<TopItem>[] = [
    { key: "item_code", header: "Item code", value: (i) => i.item_code },
    { key: "item_name", header: "Product", value: (i) => i.item_name },
    { key: "item_group", header: "Group", value: (i) => i.item_group ?? "" },
    { key: "qty", header: "Qty", value: (i) => i.qty },
    { key: "amount", header: "Sales (PKR)", value: (i) => i.amount },
    { key: "share", header: "Share %", value: (i) => i.share_pct },
  ];
  const onExport = (fmt: ExportFormat) => {
    if (!k || !c) return;
    const stem = `sales-summary-${range.start}-${range.end}`;
    if (fmt === "csv") return exportTable("csv", stem, tiles, tileCols);
    const scope = `${fmtRange(range.start, range.end)} · compared with ${cmpLabel ? `${cmpLabel} ` : ""}${prevRange}`;
    void downloadWorkbook(`${stem}.xlsx`, [
      { name: "Summary", title: "Sales Summary", subtitle: `${scope} · net sales ${pkr(c.net_sales)} on ${num(c.checks)} bills · average bill ${pkr(c.avg_check)}`, columns: tileCols, rows: tiles },
      { name: "Item groups", title: "Sales by item group", subtitle: scope, columns: groupCols, rows: groups.data?.groups ?? [], totals: true },
      { name: "Top products", title: "Top products", subtitle: scope, columns: itemCols, rows: top.data?.items ?? [], totals: true },
    ]);
  };

  const empty = !!c && c.checks === 0 && c.net_sales === 0;

  return (
    <Card
      title="Sales Summary"
      subtitle={k ? `${fmtRange(range.start, range.end)} · the whole sales picture in one view · change vs ${cmpLabel ? `${cmpLabel} ` : ""}${prevRange}` : undefined}
      source={k?.source}
      loading={kpis.loading}
      refreshing={kpis.refreshing}
      error={kpis.error}
      empty={empty}
      emptyHint="No bills in this range yet."
      onRetry={onRetry}
      height={260}
      action={k && !empty ? <ExportButtons onExport={onExport} /> : undefined}
    >
      {k && c && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            {tiles.map((t) => (
              <div key={t.n} className="flex flex-col gap-1 rounded-lg border border-line p-3" style={{ borderTop: `3px solid ${t.color}` }}>
                <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">
                  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: t.color }}>
                    {t.n}
                  </span>
                  <span className="truncate" title={t.label}>{t.label}</span>
                </span>
                <span className="tnum truncate text-lg font-semibold leading-tight text-ink" title={t.value}>{t.value}</span>
                {t.prevText !== null && (
                  <span className="text-[11px]">
                    <DeltaText value={t.delta} /> <span className="tnum text-ink-3">vs {t.prevText}</span>
                  </span>
                )}
                {t.lines.map((l) => (
                  <span key={l} className="tnum text-[11px] leading-snug text-ink-2">{l}</span>
                ))}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Ratio
              label="Discounts"
              value={pkr(c.discounts)}
              note={h ? `${num(h.discounts.pct_of_gross, 1)}% of gross sales` : undefined}
              tone={c.discounts > 0 ? "text-warn" : "text-ink"}
            />
            <Ratio
              label="Returns"
              value={c.return_count ? `${num(c.return_count)} · ${pkr(Math.abs(c.returns_total))}` : "none"}
              note={h && c.return_count ? `${num(h.returns.pct_of_gross, 1)}% of gross sales` : "no bills returned"}
              tone={c.return_count ? "text-bad" : "text-ink"}
            />
            <Ratio label="Top product" value={topItem ? topItem.item_name : "—"} note={topItem ? `${pkr(topItem.amount)} · ${topItem.share_pct}% of sales · ${num(topItem.qty)} qty` : undefined} />
            <Ratio label="Top item group" value={topGroup ? topGroup.item_group : "—"} note={topGroup ? `${pkr(topGroup.amount)} · ${topGroup.share_pct}% of sales` : undefined} />
            <Ratio label="Payment" value={topMode ? `${topMode.mode} ${topMode.share_pct}%` : "—"} note={modes.data ? `${num(modes.data.modes.length)} mode${modes.data.modes.length === 1 ? "" : "s"} · ${pkr(modes.data.total)} settled` : undefined} />
            <Ratio
              label="Last bill entered"
              value={h?.last_bill_date ? `${fmtDate(h.last_bill_date)}${h.last_bill_time ? ` ${h.last_bill_time.slice(0, 5)}` : ""}` : "—"}
              note={h ? `${num(h.draft_bills)} draft · ${num(h.cancelled_bills)} cancelled` : undefined}
              tone={h && (h.days_without_entry ?? 0) >= 2 ? "text-warn" : "text-ink"}
            />
          </div>

          {groups.data && groups.data.groups.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className={thead}>
                    <th className={th}>Item group</th>
                    <th className={`${th} text-right`}>Sales</th>
                    <th className={`${th} text-right`}>Qty</th>
                    <th className={`${th} text-right`}>Products</th>
                    <th className={`${th} text-right`}>Avg rate</th>
                    <th className={`${th} text-right`}>Share of sales</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {groups.data.groups.map((g) => (
                    <tr key={g.item_group} className="border-b border-line/60">
                      <td className="py-1.5 text-ink">{g.item_group}</td>
                      <td className="py-1.5 text-right font-medium text-ink">{pkr(g.amount)}</td>
                      <td className={tdNum}>{num(g.qty)}</td>
                      <td className={tdNum}>{num(g.items)}</td>
                      <td className={tdNum}>{g.qty ? pkr(g.amount / g.qty) : "—"}</td>
                      <td className={tdNum}>{g.share_pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-ink-3">
            The outlet sold {pkr(c.net_sales)} on {num(c.checks)} bills, {num(c.total_qty)} units in all, an average bill of {pkr(c.avg_check)} with {num(c.items_per_check, 1)} items on it.
            {r ? ` Bills were entered on ${num(r.active_days)} of ${num(r.calendar_days)} din, about ${pkr(r.avg_per_active_day)} per trading day.` : ""}
            {topItem ? ` ${topItem.item_name} was the top product at ${topItem.share_pct}% of sales.` : ""}
            {m && !m.is_complete ? ` ${m.label} stands at ${pkr(m.mtd)} and is projected to close near ${pkr(m.projected)}.` : ""} Details are in the cards below.
          </p>
        </div>
      )}
    </Card>
  );
}
