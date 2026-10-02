import type { CsvColumn } from "./csv";

/** One worksheet: a title block, a styled header row, then the rows. */
export interface SheetSpec<T = unknown> {
  /** tab name (31 chars max in Excel) */
  name: string;
  title: string;
  subtitle?: string;
  columns: CsvColumn<T>[];
  rows: T[];
  /** add a bold total row summing every numeric column except these keys */
  totals?: boolean;
  /** columns whose numbers should not be summed in the total row (rates, shares, counts of days…) */
  noTotal?: string[];
}

const ACCENT = "FF2A78D6";
const ACCENT_SOFT = "FFE4EFFB";
const INK_3 = "FF898781";
const LINE = "FFD9D9D9";

/** Excel number format for a column, from its header wording and the values it carries. */
function numberFormat(header: string, sample: unknown): string | undefined {
  if (typeof sample !== "number") return undefined;
  if (/%|chg|change/i.test(header)) return '0.0"%"';
  if (/rate|avg rate|valuation/i.test(header)) return "#,##0.00";
  if (/qty|days|din|entries|items|invoices|products|materials|documents|cover|count/i.test(header)) return "#,##0.###";
  return "#,##0";
}

/**
 * Build a styled .xlsx with one tab per sheet and hand it to the browser as a download.
 * Each tab: title (row 1), subtitle (row 2), header row 4 (blue, bold, filtered, frozen), data from row 5,
 * optional bold total row, thin borders, number formats and column widths fitted to the content.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function downloadWorkbook(filename: string, sheets: SheetSpec<any>[], meta: { creator?: string } = {}): Promise<void> {
  const mod = await import("exceljs");
  const ExcelJS = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.creator ?? "Sindh Bakery dashboard";
  wb.created = new Date();
  const used = new Set<string>();

  for (const sheet of sheets) {
    let name = sheet.name.replace(/[\\/*?:[\]]/g, " ").slice(0, 31) || "Sheet";
    while (used.has(name)) name = name.slice(0, 29) + " 2";
    used.add(name);
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 4 }] });
    const cols = sheet.columns as CsvColumn<unknown>[];
    const rows = sheet.rows as unknown[];
    const n = cols.length;

    // title block
    ws.mergeCells(1, 1, 1, Math.max(1, n));
    const t = ws.getCell(1, 1);
    t.value = sheet.title;
    t.font = { bold: true, size: 14, color: { argb: "FF0B0B0B" } };
    ws.getRow(1).height = 22;
    if (sheet.subtitle) {
      ws.mergeCells(2, 1, 2, Math.max(1, n));
      const s = ws.getCell(2, 1);
      s.value = sheet.subtitle;
      s.font = { italic: true, size: 10, color: { argb: INK_3 } };
    }

    // header
    const header = ws.getRow(4);
    cols.forEach((c, i) => {
      const cell = header.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
      cell.alignment = { vertical: "middle", horizontal: rows.length && typeof c.value(rows[0]) === "number" ? "right" : "left", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: LINE } } };
    });
    header.height = 20;

    // data
    const formats = cols.map((c) => numberFormat(c.header, rows.length ? c.value(rows[0]) : undefined));
    rows.forEach((r, ri) => {
      const row = ws.getRow(5 + ri);
      cols.forEach((c, i) => {
        const v = c.value(r);
        const cell = row.getCell(i + 1);
        cell.value = v === undefined || v === null ? null : v;
        if (typeof v === "number") {
          cell.numFmt = formats[i] ?? "#,##0";
          cell.alignment = { horizontal: "right" };
        }
        cell.border = { bottom: { style: "hair", color: { argb: LINE } } };
        if (ri % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F7F5" } };
      });
    });

    // totals
    if (sheet.totals && rows.length) {
      const row = ws.getRow(5 + rows.length);
      const skip = new Set(sheet.noTotal ?? []);
      cols.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        const numeric = rows.every((r) => typeof c.value(r) === "number" || c.value(r) == null);
        if (i === 0) cell.value = "Total";
        else if (numeric && !skip.has(c.key) && !/%|chg|change|rate|share/i.test(c.header)) {
          cell.value = Math.round(rows.reduce<number>((sum, r) => sum + (Number(c.value(r)) || 0), 0) * 100) / 100;
          cell.numFmt = formats[i] ?? "#,##0";
          cell.alignment = { horizontal: "right" };
        }
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_SOFT } };
        cell.border = { top: { style: "thin", color: { argb: ACCENT } } };
      });
    }

    // widths + filter
    cols.forEach((c, i) => {
      const longest = Math.max(c.header.length, ...rows.slice(0, 300).map((r) => String(c.value(r) ?? "").length));
      ws.getColumn(i + 1).width = Math.min(48, Math.max(9, longest + 3));
    });
    if (rows.length) ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + rows.length, column: n } };
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
