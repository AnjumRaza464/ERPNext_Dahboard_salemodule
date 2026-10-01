"use client";

import type { ExportFormat } from "@/lib/csv";

const cls = "rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:bg-surface-2";

/** CSV and Excel download buttons for a table; the caller decides which rows go out (filtered rows, usually). */
export default function ExportButtons({ onExport }: { onExport: (fmt: ExportFormat) => void }) {
  return (
    <div className="flex items-center gap-1">
      <button onClick={() => onExport("csv")} className={cls} title="Download this table as CSV">
        CSV
      </button>
      <button onClick={() => onExport("xlsx")} className={cls} title="Download this table as an Excel workbook (.xlsx)">
        Excel
      </button>
    </div>
  );
}
