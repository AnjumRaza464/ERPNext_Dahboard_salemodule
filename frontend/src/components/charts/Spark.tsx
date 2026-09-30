"use client";

export interface SparkSeries {
  values: (number | null)[];
  color: string;
  dashed?: boolean;
}

/** Tiny inline line(s) on one shared scale: the first series solid, comparisons dashed. */
export default function Spark({ series, width = 96, height = 30 }: { series: SparkSeries[]; width?: number; height?: number }) {
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (all.length < 2) return <div style={{ width, height }} />;
  const max = Math.max(...all);
  const min = Math.min(0, ...all);
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * (width - 2) + 1 : width / 2);
  const y = (v: number) => (max === min ? height / 2 : height - 2 - ((v - min) / (max - min)) * (height - 4));
  return (
    <svg width={width} height={height} aria-hidden="true" className="shrink-0">
      {series.map((s, si) => {
        const pts = s.values.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(" ");
        return pts ? (
          <polyline key={si} points={pts} fill="none" stroke={s.color} strokeWidth={si === 0 ? 1.8 : 1.2} strokeDasharray={s.dashed ? "3 2" : undefined} strokeLinejoin="round" strokeLinecap="round" />
        ) : null;
      })}
    </svg>
  );
}
