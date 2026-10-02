export interface CsvColumn<T> {
  key: string;
  header: string;
  value: (row: T) => string | number | null | undefined;
}

function escapeCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeCell(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => escapeCell(c.value(r))).join(","));
  return [head, ...body].join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type ExportFormat = "csv" | "xlsx";

/** Same rows and columns as the CSV, as one styled worksheet (exceljs is loaded on demand). */
export async function downloadXlsx<T>(filename: string, rows: T[], columns: CsvColumn<T>[]): Promise<void> {
  const { downloadWorkbook } = await import("./excel");
  const title = filename.replace(/\.xlsx$/i, "").replace(/[-_]+/g, " ");
  await downloadWorkbook(filename, [{ name: "Data", title, columns, rows, totals: true }]);
}

/** Download a table as CSV or Excel; `baseName` may carry a .csv suffix, the right extension is applied. */
export function exportTable<T>(fmt: ExportFormat, baseName: string, rows: T[], columns: CsvColumn<T>[]): void {
  const stem = baseName.replace(/\.csv$/i, "");
  if (fmt === "xlsx") void downloadXlsx(`${stem}.xlsx`, rows, columns);
  else downloadCsv(`${stem}.csv`, toCsv(rows, columns));
}
