"use client";

import type { ReactNode } from "react";
import type { Source } from "@/lib/types";
import { ChartSkeleton, EmptyState, ErrorState } from "./States";

export function SourceBadge({ source }: { source?: Source }) {
  if (!source) return null;
  const map: Record<Source, { label: string; tone: string }> = {
    sales_invoice: { label: "Sales Invoice", tone: "text-ink-3" },
    sales_invoice_item: { label: "Invoice Items", tone: "text-ink-3" },
    pos_invoice: { label: "POS bills", tone: "text-ink-3" },
    pos_invoice_item: { label: "POS bill items", tone: "text-ink-3" },
    stock_entry: { label: "Stock Entries", tone: "text-ink-3" },
    purchase_invoice: { label: "Purchase Invoices", tone: "text-ink-3" },
    bin: { label: "Stock balance", tone: "text-ink-3" },
  };
  const m = map[source] ?? { label: source, tone: "text-ink-3" };
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${m.tone}`} title={`Data source: ${m.label}`}>
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {m.label}
    </span>
  );
}

interface CardProps {
  title: string;
  subtitle?: string;
  source?: Source;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyHint?: string;
  onRetry?: () => void;
  action?: ReactNode;
  height?: number;
  children: ReactNode;
  className?: string;
  /** anchor for voice navigation */
  id?: string;
}

export default function Card({
  title, subtitle, source, loading, refreshing, error, empty, emptyHint, onRetry, action, height = 260, children, className = "", id,
}: CardProps) {
  return (
    <section id={id} className={`card flex scroll-mt-4 flex-col p-4 sm:p-5 ${className}`}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {action}
          <SourceBadge source={source} />
        </div>
      </header>
      <div className={`relative flex-1 transition-opacity ${refreshing ? "opacity-60" : ""}`} style={{ minHeight: height }}>
        {loading ? <ChartSkeleton height={height} /> : error ? <ErrorState message={error} onRetry={onRetry} /> : empty ? <EmptyState hint={emptyHint} /> : children}
      </div>
    </section>
  );
}
