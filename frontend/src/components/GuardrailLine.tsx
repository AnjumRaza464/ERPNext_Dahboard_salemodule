"use client";

import { fmtDate, num, pkr } from "@/lib/format";
import type { DataHealth } from "@/lib/types";

/**
 * One line under the KPI row about the data itself: when the last bill was keyed in, how many
 * of the days had entries, and any exceptions (returns, discounts, cancelled, drafts). Grey when
 * everything is zero, amber when entry is lagging or bills are pending, red when money moved out.
 */
export default function GuardrailLine({ health, onShowInvoices }: { health: DataHealth; onShowInvoices?: () => void }) {
  const lag = (health.days_without_entry ?? 0) >= 2;
  const pending = health.draft_bills > 0 || health.unconsolidated_bills > 0;
  const money = health.returns.count > 0 || health.discounts.amount > 0 || health.cancelled_bills > 0;
  const tone = money ? "text-bad" : lag || pending ? "text-warn" : "text-ink-3";
  const parts: string[] = [];
  if (health.last_bill_date) parts.push(`Last bill ${fmtDate(health.last_bill_date)}${health.last_bill_time ? " " + health.last_bill_time.slice(0, 5) : ""}`);
  parts.push(`${num(health.trading_days)} of ${num(health.calendar_days)} din entered`);
  parts.push(health.returns.count ? `${num(health.returns.count)} returns (${pkr(Math.abs(health.returns.amount))})` : "0 returns");
  parts.push(health.discounts.amount ? `discounts ${pkr(health.discounts.amount)} (${health.discounts.pct_of_gross}% of gross)` : "0 discounts");
  parts.push(health.cancelled_bills ? `${num(health.cancelled_bills)} cancelled (${pkr(health.cancelled_total)})` : "0 cancelled");
  if (health.draft_bills) parts.push(`${num(health.draft_bills)} draft bill${health.draft_bills === 1 ? "" : "s"}`);
  if (health.unconsolidated_bills) parts.push(`${num(health.unconsolidated_bills)} bill${health.unconsolidated_bills === 1 ? "" : "s"} awaiting closing`);

  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] ${tone}`} title="Data health: bills are keyed into ERPNext in batches, so figures for recent days can change">
      {(lag || pending || money) && (
        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${money ? "bg-bad/10 text-bad" : "bg-warn/10 text-warn"}`}>
          {money ? "check" : lag ? `${health.days_without_entry} din se entry nahi` : "pending"}
        </span>
      )}
      <span className="tnum">{parts.join(" · ")}</span>
      {lag && <span className="text-ink-3">· deltas for recent days may change once entries are posted</span>}
      {money && onShowInvoices && (
        <button onClick={onShowInvoices} className="underline decoration-dotted underline-offset-2 hover:text-ink">
          see invoices
        </button>
      )}
    </div>
  );
}
