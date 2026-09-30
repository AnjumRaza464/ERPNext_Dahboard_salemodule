export type Source = "sales_invoice" | "sales_invoice_item" | "pos_invoice";

export interface Range {
  start: string;
  end: string;
}

interface Base {
  source: Source;
  range: Range;
  cached?: boolean;
}

export interface SalesTotals {
  total_sales: number;
  gross_sales: number;
  returns_total: number;
  invoice_count: number;
  return_count: number;
  avg_invoice_value: number;
  outstanding: number;
  total_qty: number;
}

export interface SalesKpis extends Base {
  previous_range: Range;
  current: SalesTotals;
  previous: SalesTotals;
  delta_pct: Record<keyof SalesTotals, number | null>;
}

export interface Invoice {
  name: string;
  posting_date: string;
  posting_time: string | null;
  customer: string;
  customer_name: string;
  base_grand_total: number;
  base_net_total: number;
  total_taxes_and_charges: number;
  discount_amount: number;
  outstanding_amount: number;
  status: string;
  is_return: number;
  is_pos: number;
  cost_center: string | null;
  pos_profile: string | null;
  set_warehouse: string | null;
  total_qty: number;
  due_date: string | null;
  outlet: string;
}

export interface InvoicesResponse extends Base {
  count: number;
  invoices: Invoice[];
}

export interface TrendPoint {
  period: string;
  total: number;
  invoice_count: number;
}

export interface SalesTrend extends Base {
  granularity: "day" | "month";
  points: TrendPoint[];
}

export interface TopItem {
  item_code: string;
  item_name: string;
  item_group: string | null;
  qty: number;
  amount: number;
  share_pct: number;
}

export interface TopItems extends Base {
  items: TopItem[];
  other_amount: number;
  total_amount: number;
  distinct_items: number;
}

export interface Outlet {
  outlet: string;
  cost_center: string | null;
  pos_profile: string | null;
  total: number;
  invoice_count: number;
  avg_invoice_value: number;
  outstanding: number;
  share_pct: number;
}

export interface OutletSales extends Base {
  outlets: Outlet[];
  total: number;
}

// ---------------------------------------------------------------- sales analytics

export type CompareMode = "previous" | "last_year" | "custom";

export interface ComparePoint {
  index: number;
  period: string | null;
  previous_period: string | null;
  current: number | null;
  previous: number | null;
  current_invoices: number | null;
  previous_invoices: number | null;
  current_cum: number | null;
  previous_cum: number | null;
}

export interface CompareTotals extends SalesTotals {
  active_days: number;
  avg_per_day: number;
  avg_qty_per_invoice: number;
}

export interface SalesCompare extends Base {
  previous_range: Range;
  mode: CompareMode;
  granularity: "day" | "month";
  points: ComparePoint[];
  current_total: number;
  previous_total: number;
  delta_pct: number | null;
  delta_abs: number;
  current: CompareTotals;
  previous: CompareTotals;
  kpi_delta_pct: Partial<Record<keyof CompareTotals, number | null>>;
}

export interface CompareRow {
  label: string;
  current: number;
  previous: number;
  delta_abs: number;
  delta_pct: number | null;
}

export interface CompareGroupRow extends CompareRow {
  current_qty: number;
  previous_qty: number;
  current_share_pct: number;
  previous_share_pct: number;
}

export interface CompareItemRow extends CompareRow {
  item_code: string;
  item_group: string | null;
  current_qty: number;
  previous_qty: number;
}

export interface CompareWeekdayRow {
  label: string;
  current: number;
  previous: number;
  current_total: number;
  previous_total: number;
  delta_pct: number | null;
}

export interface CompareBreakdown extends Base {
  previous_range: Range;
  mode: CompareMode;
  item_groups: CompareGroupRow[];
  top_items: CompareItemRow[];
  gainers: CompareItemRow[];
  losers: CompareItemRow[];
  weekdays: CompareWeekdayRow[];
  new_items: number;
}

export interface MonthPoint {
  period: string;
  label: string;
  total: number;
  invoice_count: number;
  qty: number;
  avg_invoice_value: number;
  active_days: number;
  avg_per_day: number;
  mom_pct: number | null;
  last_year: number;
  yoy_pct: number | null;
  is_partial: boolean;
}

export interface MonthlySales extends Base {
  months: number;
  points: MonthPoint[];
  best_month: string | null;
  avg_month: number;
  total: number;
}

export interface HeatmapCell {
  weekday: string;
  weekday_index: number;
  hour: number;
  total: number;
  invoice_count: number;
  occurrences: number;
  avg_per_day: number;
}

export interface SalesHeatmap extends Base {
  weekdays: string[];
  cells: HeatmapCell[];
  max_avg: number;
  hour_min: number;
  hour_max: number;
  peak: { weekday: string; hour: number; avg_per_day: number } | null;
}

export interface ParetoItem {
  rank: number;
  item_code: string;
  item_name: string;
  item_group: string | null;
  amount: number;
  qty: number;
  share_pct: number;
  cum_share_pct: number;
  cls: "A" | "B" | "C";
}

export interface ParetoClass {
  cls: "A" | "B" | "C";
  items: number;
  amount: number;
  share_pct: number;
  items_pct: number;
}

export interface ItemPareto extends Base {
  items: ParetoItem[];
  classes: ParetoClass[];
  distinct_items: number;
  total_amount: number;
  items_for_80_pct: number;
}

export interface DayFigure {
  date: string;
  total: number;
  invoice_count: number;
}

export interface RunRate extends Base {
  total: number;
  calendar_days: number;
  active_days: number;
  avg_per_day: number;
  avg_per_active_day: number;
  best_day: DayFigure | null;
  worst_day: DayFigure | null;
  month: {
    start: string;
    end: string;
    label: string;
    days_in_month: number;
    elapsed_days: number;
    remaining_days: number;
    active_days: number;
    mtd: number;
    avg_per_day: number;
    projected: number;
    is_current: boolean;
    is_complete: boolean;
  };
}

export interface ItemGroupRow {
  item_group: string;
  qty: number;
  amount: number;
  items: number;
  share_pct: number;
}

export interface ItemGroupSales extends Base {
  groups: ItemGroupRow[];
  total_amount: number;
}

export interface HourPoint {
  hour: number;
  label: string;
  total: number;
  invoice_count: number;
  avg_per_day: number;
}

export interface HourlySales extends Base {
  active_days: number;
  points: HourPoint[];
  peak_hour: number | null;
}

export interface WeekdayPoint {
  weekday: string;
  total: number;
  invoice_count: number;
  occurrences: number;
  avg_per_day: number;
}

export interface WeekdaySales extends Base {
  points: WeekdayPoint[];
  best_weekday: string | null;
}

export interface DistributionBucket {
  bucket: string;
  min: number;
  max: number | null;
  invoice_count: number;
  total: number;
}

export interface InvoiceDistribution extends Base {
  buckets: DistributionBucket[];
  stats: { count: number; median: number; mean: number; min: number; max: number; p90: number };
}

export interface CustomerRow {
  customer: string;
  customer_name: string;
  total: number;
  invoice_count: number;
  avg_invoice_value: number;
  outstanding: number;
  last_invoice: string;
  share_pct: number;
}

export interface TopCustomers extends Base {
  customers: CustomerRow[];
  distinct_customers: number;
  total: number;
}

export interface PaymentMode {
  mode: string;
  amount: number;
  count: number;
  share_pct: number;
}

export interface PaymentModes extends Base {
  modes: PaymentMode[];
  total: number;
}

export interface WaterfallStep {
  label: string;
  amount: number;
  kind: "total" | "delta";
}

export interface SalesComposition extends Base {
  steps: WaterfallStep[];
  gross: number;
  discount: number;
  taxes: number;
  returns: number;
  net_sales: number;
  invoice_count: number;
  return_count: number;
  discount_pct: number;
}

// ---------------------------------------------------------------- live comparison board

export type LiveMetric = "sales" | "gcs" | "avg_check" | "qty";
export type LivePeriodKey = "current" | "previous" | "last_week";

export interface LiveTotals {
  sales: number;
  gross_sales: number;
  returns_total: number;
  /** guest checks: POS invoices rung up (returns excluded) */
  gcs: number;
  return_count: number;
  /** net sales / gcs */
  avg_check: number;
  qty: number;
}

export interface LivePeriod {
  key: LivePeriodKey;
  range: Range;
  totals: LiveTotals;
}

export interface LiveDelta {
  abs: number;
  pct: number | null;
}

export interface LivePoint {
  index: number;
  label: string;
  dates: Record<LivePeriodKey, string>;
  current: number | null;
  previous: number | null;
  last_week: number | null;
  current_gcs: number | null;
  previous_gcs: number | null;
  last_week_gcs: number | null;
}

export interface LiveCompare extends Base {
  as_of: string;
  days: number;
  granularity: "hour" | "day";
  periods: Record<LivePeriodKey, LivePeriod>;
  deltas: Record<"previous" | "last_week", Record<LiveMetric, LiveDelta>>;
  points: LivePoint[];
  last_trading_day: string | null;
}
