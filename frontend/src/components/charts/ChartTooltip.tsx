"use client";

export interface TooltipEntry {
  name?: string | number;
  dataKey?: string | number;
  value?: number | string | ReadonlyArray<number | string>;
  color?: string;
  payload?: Record<string, unknown>;
}

export interface TooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<TooltipEntry>;
  label?: string | number;
  /** how to render a row's value */
  format?: (value: number, entry: TooltipEntry) => string;
  /** how to render the header */
  labelFormat?: (label: string | number, entry?: TooltipEntry) => string;
  /** hide the colour swatch (single series) */
  noSwatch?: boolean;
}

export default function ChartTooltip({ active, payload, label, format, labelFormat, noSwatch }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const first = payload[0];
  const head = labelFormat ? labelFormat(label ?? "", first) : String(label ?? "");
  return (
    <div className="card min-w-[140px] px-3 py-2 text-xs shadow-lg" style={{ background: "var(--surface)" }}>
      {head && <div className="mb-1 font-medium text-ink">{head}</div>}
      <div className="flex flex-col gap-0.5">
        {payload.map((entry, i) => {
          const v = typeof entry.value === "number" ? entry.value : Number(entry.value ?? 0);
          return (
            <div key={i} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-ink-2">
                {!noSwatch && <span className="inline-block h-2 w-2 rounded-sm" style={{ background: entry.color }} />}
                {String(entry.name ?? entry.dataKey ?? "")}
              </span>
              <span className="tnum font-medium text-ink">{format ? format(v, entry) : v.toLocaleString()}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
