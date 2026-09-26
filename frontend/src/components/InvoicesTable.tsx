"use client";

import { useMemo, useState } from "react";
import { downloadCsv, toCsv, type CsvColumn } from "@/lib/csv";
import { fmtDate, num, pkr } from "@/lib/format";
import type { Invoice, InvoicesResponse } from "@/lib/types";
import { EmptyState, ErrorState, Skeleton } from "./States";
import { SourceBadge } from "./Card";

type SortKey = keyof Pick<Invoice, "name" | "posting_date" | "customer_name" | "outlet" | "status" | "total_qty" | "base_net_total" | "base_grand_total" | "outstanding_amount">;

interface Column {
  key: SortKey;
  label: string;
  align?: "right";
  render: (r: Invoice) => string;
}

const COLUMNS: Column[] = [
  { key: "name", label: "Invoice", render: (r) => r.name },
  { key: "posting_date", label: "Date", render: (r) => `${fmtDate(r.posting_date)}${r.posting_time ? " " + r.posting_time.slice(0, 5) : ""}` },
  { key: "customer_name", label: "Customer", render: (r) => r.customer_name || r.customer },
  { key: "outlet", label: "Outlet", render: (r) => r.outlet },
  { key: "status", label: "Status", render: (r) => (r.is_return ? "Return" : r.status) },
  { key: "total_qty", label: "Qty", align: "right", render: (r) => num(r.total_qty, 2) },
  { key: "base_net_total", label: "Net", align: "right", render: (r) => pkr(r.base_net_total) },
  { key: "base_grand_total", label: "Grand Total", align: "right", render: (r) => pkr(r.base_grand_total) },
  { key: "outstanding_amount", label: "Outstanding", align: "right", render: (r) => pkr(r.outstanding_amount) },
];

const CSV_COLUMNS: CsvColumn<Invoice>[] = [
  { key: "name", header: "Invoice", value: (r) => r.name },
  { key: "posting_date", header: "Posting Date", value: (r) => r.posting_date },
  { key: "posting_time", header: "Posting Time", value: (r) => r.posting_time },
  { key: "customer", header: "Customer ID", value: (r) => r.customer },
  { key: "customer_name", header: "Customer", value: (r) => r.customer_name },
  { key: "outlet", header: "Outlet", value: (r) => r.outlet },
  { key: "pos_profile", header: "POS Profile", value: (r) => r.pos_profile },
  { key: "status", header: "Status", value: (r) => (r.is_return ? "Return" : r.status) },
  { key: "total_qty", header: "Qty", value: (r) => r.total_qty },
  { key: "base_net_total", header: "Net Total (PKR)", value: (r) => r.base_net_total },
  { key: "total_taxes_and_charges", header: "Taxes (PKR)", value: (r) => r.total_taxes_and_charges },
  { key: "discount_amount", header: "Discount (PKR)", value: (r) => r.discount_amount },
  { key: "base_grand_total", header: "Grand Total (PKR)", value: (r) => r.base_grand_total },
  { key: "outstanding_amount", header: "Outstanding (PKR)", value: (r) => r.outstanding_amount },
  { key: "due_date", header: "Due Date", value: (r) => r.due_date },
];

function statusTone(r: Invoice): string {
  if (r.is_return) return "bg-surface-2 text-ink-2";
  switch (r.status) {
    case "Paid":
      return "text-good";
    case "Overdue":
      return "text-bad";
    case "Unpaid":
    case "Partly Paid":
      return "text-warn";
    default:
      return "text-ink-2";
  }
}

interface Props {
  state: { data: InvoicesResponse | null; loading: boolean; refreshing: boolean; error: string | null };
  range: { start: string; end: string };
  onRetry?: () => void;
}

const PAGE = 25;

export default function InvoicesTable({ state, range, onRetry }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "posting_date", dir: "desc" });
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const rows = useMemo(() => {
    const all = state.data?.invoices ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? all.filter((r) => [r.name, r.customer_name, r.customer, r.outlet, r.status].some((v) => (v || "").toLowerCase().includes(q)))
      : all;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
      if (cmp === 0 && sort.key === "posting_date") return (a.posting_time || "").localeCompare(b.posting_time || "") * dir;
      return cmp * dir;
    });
  }, [state.data, sort, query]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * PAGE, current * PAGE + PAGE);
  const totals = useMemo(
    () => rows.reduce((acc, r) => ({ grand: acc.grand + r.base_grand_total, out: acc.out + r.outstanding_amount }), { grand: 0, out: 0 }),
    [rows],
  );

  const toggleSort = (key: SortKey) => {
    setPage(0);
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "posting_date" ? "desc" : "asc" }));
  };

  const exportCsv = () => downloadCsv(`sales-invoices_${range.start}_to_${range.end}.csv`, toCsv(rows, CSV_COLUMNS));

  return (
    <section className={`card p-4 sm:p-5 transition-opacity ${state.refreshing ? "opacity-60" : ""}`}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Sales Invoices</h3>
          <p className="mt-0.5 text-xs text-ink-3">
            {state.data ? `${rows.length} of ${state.data.count} invoices · ${pkr(totals.grand)} total` : "Submitted invoices in the selected range"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="Search invoice, customer, outlet…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            className="w-56 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-3"
          />
          <button
            onClick={exportCsv}
            disabled={!rows.length}
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-40"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
            Export CSV
          </button>
          <SourceBadge source={state.data?.source} />
        </div>
      </header>

      {state.loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <EmptyState title={query ? "No invoices match your search" : "No submitted invoices in this range"} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-xs">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                  {COLUMNS.map((c) => {
                    const active = sort.key === c.key;
                    return (
                      <th key={c.key} className={`py-2 pr-3 font-medium ${c.align === "right" ? "text-right" : ""}`} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                        <button onClick={() => toggleSort(c.key)} className={`inline-flex items-center gap-1 hover:text-ink ${active ? "text-ink" : ""}`}>
                          {c.label}
                          <span className="text-[9px]">{active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="tnum">
                {visible.map((r) => (
                  <tr key={r.name} className="border-b border-line/60 hover:bg-surface-2">
                    {COLUMNS.map((c) => (
                      <td key={c.key} className={`py-2 pr-3 ${c.align === "right" ? "text-right" : ""} ${c.key === "status" ? statusTone(r) : c.key === "name" ? "font-medium text-ink" : "text-ink-2"}`}>
                        {c.render(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-ink font-medium">
                  <td className="py-2 pr-3" colSpan={7}>
                    Total ({rows.length} invoices)
                  </td>
                  <td className="py-2 pr-3 text-right tnum">{pkr(totals.grand)}</td>
                  <td className="py-2 pr-3 text-right tnum">{pkr(totals.out)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-between text-xs text-ink-3">
              <span>
                Page {current + 1} of {pages}
              </span>
              <div className="flex gap-1">
                <button onClick={() => setPage(Math.max(0, current - 1))} disabled={current === 0} className="rounded-md border border-line px-2.5 py-1 hover:bg-surface-2 disabled:opacity-40">
                  Prev
                </button>
                <button onClick={() => setPage(Math.min(pages - 1, current + 1))} disabled={current >= pages - 1} className="rounded-md border border-line px-2.5 py-1 hover:bg-surface-2 disabled:opacity-40">
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
