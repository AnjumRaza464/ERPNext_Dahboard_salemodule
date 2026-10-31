// Illustrative data for the 3D board on the sign-in page. Deliberately synthetic and seeded:
// nothing from ERPNext is shown before sign-in, and every visit draws the same city.

export type SceneMode = "sales" | "costing" | "forecast" | "decline" | "stock" | "voice";

export const GROUPS = ["Bread", "Cakes", "Rusk", "Biscuits", "Savoury", "Drinks"];
export const DAYS = 14;

export interface Cell {
  /** 0..1, bar height relative to the tallest bar of the mode */
  height: number;
  color: string;
  title: string;
  label: string;
}

export interface ModeInfo {
  id: SceneMode;
  tab: string;
  title: string;
  body: string;
  color: string;
  icon: string;
  kpis: { label: string; value: string }[];
}

// ------------------------------------------------------------------ seeded base figures
let seed = 20261031;
const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

const START = new Date(2026, 9, 18);
const WEEKDAY = [1.2, 0.86, 0.9, 0.92, 0.97, 1.1, 1.26]; // Sun..Sat
const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GROUP_SALES = [42000, 61000, 18000, 22000, 27000, 9000];
const COST_SHARE = [0.52, 0.58, 0.45, 0.5, 0.55, 0.35];
const AVG_BILL = 265;
const PLAN_FROM = DAYS - 3; // last three columns are the bake plan in "forecast"

const dayLabel = (c: number) => {
  const d = new Date(START);
  d.setDate(START.getDate() + c);
  return `${NAMES[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

const SALES = GROUPS.map((_, r) =>
  Array.from({ length: DAYS }, (_, c) => {
    const d = new Date(START);
    d.setDate(START.getDate() + c);
    return Math.round(GROUP_SALES[r] * WEEKDAY[d.getDay()] * (0.85 + rand() * 0.3));
  }),
);
const COST = SALES.map((row, r) => row.map((v) => Math.round(v * COST_SHARE[r] * (0.94 + rand() * 0.12))));
const CHANGE = SALES.map((row) => row.map(() => Math.round((rand() * 45 - 25) * 10) / 10));
const STOCK = SALES.map((row) => row.map(() => (rand() < 0.08 ? 0 : Math.round(rand() < 0.2 ? 4 + rand() * 14 : 25 + rand() * 110))));
const UNIT_PRICE = [120, 650, 220, 180, 90, 60];

// ------------------------------------------------------------------ helpers
function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  const k = Math.max(0, Math.min(1, t));
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, "0")).join("");
}

const rs = (n: number) => (n >= 1e6 ? `Rs ${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `Rs ${(n / 1e3).toFixed(1)}k` : `Rs ${Math.round(n)}`);
const sum = (m: number[][]) => m.reduce((a, row) => a + row.reduce((b, v) => b + v, 0), 0);

function grid(fn: (r: number, c: number) => Omit<Cell, "title"> & { title?: string }): Cell[] {
  const out: Cell[] = [];
  for (let r = 0; r < GROUPS.length; r++)
    for (let c = 0; c < DAYS; c++) {
      const cell = fn(r, c);
      out.push({ ...cell, title: cell.title ?? `${GROUPS[r]} · ${dayLabel(c)}` });
    }
  return out;
}

// ------------------------------------------------------------------ the six modes
const maxSales = Math.max(...SALES.flat());
const maxCost = Math.max(...COST.flat());
const plan = SALES.map((row, r) => row.map((v) => Math.round((v / UNIT_PRICE[r]) * 1.04)));
const maxPlan = Math.max(...plan.flat());

export function buildCells(mode: SceneMode): Cell[] {
  switch (mode) {
    case "sales":
      return grid((r, c) => {
        const h = SALES[r][c] / maxSales;
        return { height: h, color: mix("#1d3a66", "#7ab4ff", h), label: `${rs(SALES[r][c])} sales · ${Math.round(SALES[r][c] / AVG_BILL)} bills` };
      });
    case "costing":
      return grid((r, c) => {
        const h = COST[r][c] / maxCost;
        return { height: h, color: mix("#5a2a12", "#ffb37a", h), label: `${rs(COST[r][c])} material · ${Math.round((COST[r][c] / SALES[r][c]) * 100)}% of sales` };
      });
    case "forecast":
      return grid((r, c) => {
        const h = plan[r][c] / maxPlan;
        return c >= PLAN_FROM
          ? { height: h, color: mix("#0f5c40", "#6af5c0", h), title: `${GROUPS[r]} · plan for ${dayLabel(c)}`, label: `Bake ${plan[r][c]} pcs` }
          : { height: h * 0.8, color: mix("#232b38", "#4a5568", h), label: `Sold ${plan[r][c]} pcs` };
      });
    case "decline":
      return grid((r, c) => {
        const v = CHANGE[r][c];
        return v < 0
          ? { height: Math.max(0.06, -v / 25), color: mix("#5c1f1f", "#ff7a7a", -v / 25), label: `Sales ${v.toFixed(1)}% vs last month` }
          : { height: Math.max(0.06, v / 25), color: mix("#0f4a35", "#4fe3a7", v / 20), label: `Sales +${v.toFixed(1)}% vs last month` };
      });
    case "stock":
      return grid((r, c) => {
        const q = STOCK[r][c];
        if (q === 0) return { height: 0.04, color: "#ff5c5c", title: `${GROUPS[r]} · item ${c + 1}`, label: "Out of stock" };
        if (q < 20) return { height: q / 135, color: "#f5b14c", title: `${GROUPS[r]} · item ${c + 1}`, label: `${q} pcs · low, under a week of cover` };
        return { height: q / 135, color: mix("#1c4a3a", "#4fe3a7", q / 135), title: `${GROUPS[r]} · item ${c + 1}`, label: `${q} pcs in stock` };
      });
    case "voice":
      return grid((r, c) => ({
        height: 0.3,
        color: mix("#3b2a7a", "#c3b0ff", c / (DAYS - 1)),
        title: "Voice assistant",
        label: ["“aaj ki sale kitni hai?”", "“kal ka plan batao”", "“target ka kitna hua?”"][(r + c) % 3],
      }));
  }
}

const totalSales = sum(SALES);
const totalCost = sum(COST);
const flatChange = CHANGE.flat();
const worst = flatChange.indexOf(Math.min(...flatChange));
const flatStock = STOCK.flat();

export const MODES: ModeInfo[] = [
  {
    id: "sales",
    tab: "Sales",
    title: "Sales board",
    body: "Live day against last month, weekly rhythm, product mix and a 12-month trend.",
    color: "#4f97f0",
    icon: "M3 17l5-5 4 4 8-8M15 8h5v5",
    kpis: [
      { label: "Net sales", value: rs(totalSales) },
      { label: "Bills", value: Math.round(totalSales / AVG_BILL).toLocaleString("en-US") },
      { label: "Avg bill", value: rs(AVG_BILL) },
    ],
  },
  {
    id: "costing",
    tab: "Costing",
    title: "Costing",
    body: "Material cost by department, production against sold, and cost as a share of sales.",
    color: "#ff8a4c",
    icon: "M4 19V9m6 10V5m6 14v-7m4 7H2",
    kpis: [
      { label: "Material cost", value: rs(totalCost) },
      { label: "Cost of sales", value: `${((totalCost / totalSales) * 100).toFixed(1)}%` },
      { label: "Gross margin", value: `${(100 - (totalCost / totalSales) * 100).toFixed(1)}%` },
    ],
  },
  {
    id: "forecast",
    tab: "Forecast",
    title: "Production forecast",
    body: "Tomorrow's bake plan from sales, production and the outlet's current stock.",
    color: "#22c58b",
    icon: "M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
    kpis: [
      { label: "Items planned", value: "38" },
      { label: "Pieces tomorrow", value: plan.reduce((a, row) => a + row[PLAN_FROM], 0).toLocaleString("en-US") },
      { label: "Based on", value: "4 weekdays" },
    ],
  },
  {
    id: "decline",
    tab: "Decline & Cost",
    title: "Sales decline & cost increase",
    body: "Ranked factors behind every drop in sales or rise in cost, trading-board style.",
    color: "#e66767",
    icon: "M3 7l6 6 4-4 8 8M21 11v6h-6",
    kpis: [
      { label: "Down", value: `${flatChange.filter((v) => v < 0).length} item-days` },
      { label: "Up", value: `${flatChange.filter((v) => v >= 0).length} item-days` },
      { label: "Biggest drop", value: `${GROUPS[Math.floor(worst / DAYS)]} ${flatChange[worst].toFixed(0)}%` },
    ],
  },
  {
    id: "stock",
    tab: "Stock",
    title: "Stock tracking",
    body: "Opening, in, out and closing per item and warehouse, with purchase analysis.",
    color: "#f5b14c",
    icon: "M3 7l9-4 9 4-9 4-9-4zm0 0v10l9 4 9-4V7M12 11v10",
    kpis: [
      { label: "Items tracked", value: String(flatStock.length) },
      { label: "Low stock", value: String(flatStock.filter((q) => q > 0 && q < 20).length) },
      { label: "Out of stock", value: String(flatStock.filter((q) => q === 0).length) },
    ],
  },
  {
    id: "voice",
    tab: "Voice",
    title: "Voice assistant",
    body: "Ask in Urdu or English — “aaj ki sale kitni hai?” — and hear the answer read back.",
    color: "#9b7bff",
    icon: "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3",
    kpis: [
      { label: "Speaks", value: "Urdu · English" },
      { label: "Answers", value: "Spoken aloud" },
      { label: "Try", value: "“kal ka plan”" },
    ],
  },
];
