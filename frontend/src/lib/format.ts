const full = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const two = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "PKR 1,921,719" */
export function pkr(value: number | null | undefined, opts: { decimals?: boolean; sign?: boolean } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const body = opts.decimals ? two.format(abs) : full.format(abs);
  const sign = value < 0 ? "−" : opts.sign && value > 0 ? "+" : "";
  return `${sign}PKR ${body}`;
}

/** "1.92M", "845K", "12.3K" — axis ticks and compact tiles */
export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
  return `${sign}${full.format(abs)}`;
}

export function num(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals }).format(value);
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

const monthShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${monthShort[m - 1]} ${y}`;
}

export function fmtPeriod(iso: string, granularity: "day" | "month"): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (granularity === "month") return `${monthShort[m - 1]} ${String(y).slice(2)}`;
  return `${d} ${monthShort[m - 1]}`;
}

export function fmtRange(start: string, end: string): string {
  return start === end ? fmtDate(start) : `${fmtDate(start)} – ${fmtDate(end)}`;
}

export function fmtTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
