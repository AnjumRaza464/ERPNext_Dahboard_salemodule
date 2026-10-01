export type Source = "sales_invoice" | "sales_invoice_item" | "pos_invoice" | "pos_invoice_item" | "stock_entry" | "purchase_invoice" | "bin";

export interface Range {
  start: string;
  end: string;
}

interface Base {
  source: Source;
  range: Range;
  cached?: boolean;
}

export type CompareMode = "previous" | "last_week" | "last_year" | "custom";

/** Period totals on bills (POS Invoice). `invoice_count` / `avg_invoice_value` are aliases kept for older callers. */
export interface SalesTotals {
  net_sales: number;
  total_sales: number;
  gross_sales: number;
  discounts: number;
  returns_total: number;
  return_count: number;
  /** bills (guest checks) */
  checks: number;
  invoice_count: number;
  /** net sales / bills, excluding bulk-entry days */
  avg_check: number;
  avg_invoice_value: number;
  total_qty: number;
  items_per_check: number;
  avg_qty_per_invoice: number;
  active_days: number;
  checks_per_trading_day: number;
  avg_per_day: number;
  excluded_days: string[];
}

export interface DataHealth {
  last_bill_date: string | null;
  last_bill_time: string | null;
  days_without_entry: number | null;
  draft_bills: number;
  unconsolidated_bills: number;
  cancelled_bills: number;
  cancelled_total: number;
  calendar_days: number;
  trading_days: number;
  returns: { count: number; amount: number; pct_of_gross: number };
  discounts: { amount: number; pct_of_gross: number };
}

export interface SalesKpis extends Base {
  mode: CompareMode;
  previous_range: Range;
  current: SalesTotals;
  previous: SalesTotals;
  delta_pct: Partial<Record<keyof SalesTotals, number | null>>;
  health: DataHealth;
  excluded_days: string[];
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
  note?: string;
}

export interface TrendPoint {
  period: string;
  total: number;
  invoice_count: number;
  checks: number;
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
  checks: number;
  avg_invoice_value: number;
  outstanding: number;
  share_pct: number;
}

export interface OutletSales extends Base {
  outlets: Outlet[];
  total: number;
}

// ---------------------------------------------------------------- comparison

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

export type CompareTotals = SalesTotals;

/** How the change in sales splits into more/fewer bills (traffic) and bigger/smaller bills (spend). */
export interface Attribution {
  delta_sales: number;
  traffic_effect: number;
  spend_effect: number;
  traffic_pct: number | null;
  spend_pct: number | null;
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
  attribution: Attribution | null;
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
  current_n: number;
  previous_n: number;
  delta_pct: number | null;
}

export interface CompareBreakdown extends Base {
  previous_range: Range;
  mode: CompareMode;
  item_groups: CompareGroupRow[];
  top_items: CompareItemRow[];
  /** slowest sellers of this period (items that did sell, smallest value first) */
  bottom_items: CompareItemRow[];
  gainers: CompareItemRow[];
  losers: CompareItemRow[];
  weekdays: CompareWeekdayRow[];
  new_items: number;
  /** items sold in the comparison period but not at all in this one */
  dropped_items: number;
}

// ---------------------------------------------------------------- history, pace, target

export interface MonthPoint {
  period: string;
  label: string;
  total: number;
  invoice_count: number;
  checks: number;
  qty: number;
  avg_invoice_value: number;
  avg_check: number;
  items_per_check: number;
  active_days: number;
  avg_per_day: number;
  avg_per_trading_day: number;
  mom_pct: number | null;
  last_year: number;
  yoy_pct: number | null;
  is_partial: boolean;
  /** bulk / opening-entry days inside the month (left out of averages) */
  excluded_days: string[];
}

export interface MonthlySales extends Base {
  months: number;
  points: MonthPoint[];
  best_month: string | null;
  avg_month: number;
  total: number;
}

export interface DayFigure {
  date: string;
  total: number;
  invoice_count: number;
  checks: number;
}

export type TargetStatus = "achieved" | "on_track" | "at_risk" | "behind";

export interface MonthTarget {
  amount: number;
  source: "env" | "client" | null;
  attainment_pct: number;
  required_per_trading_day: number | null;
  remaining_to_target: number;
  status: TargetStatus;
}

export interface RunRate extends Base {
  total: number;
  calendar_days: number;
  active_days: number;
  avg_per_day: number;
  avg_per_active_day: number;
  avg_checks_per_active_day: number;
  best_day: DayFigure | null;
  worst_day: DayFigure | null;
  excluded_days: string[];
  month: {
    start: string;
    end: string;
    label: string;
    key: string;
    days_in_month: number;
    elapsed_days: number;
    remaining_days: number;
    active_days: number;
    remaining_trading_days: number;
    expected_trading_ratio: number;
    mtd: number;
    avg_per_day: number;
    avg_per_trading_day: number;
    projected: number;
    projection_basis: "active_day_pace" | "previous_month_pace";
    is_current: boolean;
    is_complete: boolean;
    target: MonthTarget | null;
  };
}

// ---------------------------------------------------------------- weekly rhythm

export interface WeekDayFigure {
  date: string;
  net_sales: number;
  checks: number;
  avg_check: number;
  qty?: number;
  excluded?: boolean;
}

export interface WeekAvg4 {
  net_sales: number;
  checks: number;
  avg_check: number;
  trading_weeks: number;
}

export interface WeekDay {
  weekday: string;
  date: string;
  is_today: boolean;
  is_future: boolean;
  net_sales: number;
  checks: number;
  avg_check: number;
  qty: number;
  excluded: boolean;
  share_of_week_pct: number;
  last_week: WeekDayFigure | null;
  avg4: WeekAvg4 | null;
  delta_vs_last_week_pct: number | null;
  delta_vs_avg4_pct: number | null;
}

export interface WeeklySales {
  source: Source;
  cached?: boolean;
  week: { start: string; end: string; label: string; is_current: boolean; can_go_back: boolean; can_go_forward: boolean };
  days: WeekDay[];
  wtd: {
    net_sales: number;
    checks: number;
    avg_check: number;
    last_week_net_sales: number;
    last_week_checks: number;
    vs_last_week_pct: number | null;
    avg4_net_sales: number;
    vs_avg4_pct: number | null;
    trading_days: number;
  };
  best_day: { weekday: string; date: string; net_sales: number } | null;
  excluded_days: string[];
}

// ---------------------------------------------------------------- product mix

export interface PmixItem {
  item_code: string;
  item_name: string;
  item_group: string;
  qty: number;
  net_sales: number;
  qty_share_pct: number;
  sales_share_pct: number;
  avg_price: number;
  prev_qty: number;
  prev_net_sales: number;
  delta_qty_pct: number | null;
  delta_sales_pct: number | null;
  delta_sales_abs: number;
  is_new: boolean;
  is_dropped: boolean;
  is_declining: boolean;
}

export interface Pmix extends Base {
  previous_range: Range;
  mode: CompareMode;
  items: PmixItem[];
  groups: { item_group: string; qty: number; net_sales: number; share_pct: number; items: number }[];
  totals: { qty: number; net_sales: number; distinct_items: number; new_items: number; dropped_items: number; declining_items: number };
  top5_share_pct: number;
}

export interface VelocityItem {
  item_code: string;
  item_name: string;
  item_group: string | null;
  total_qty: number;
  /** units per trading day over the window */
  typical_qty: number;
  /** units on the same weekday as the next day, averaged (null when that weekday never traded) */
  weekday_qty: number | null;
  weekday_n: number;
  days_sold: number;
  last_4_days: number[];
}

export interface ItemVelocity extends Base {
  next_day: { date: string; weekday: string };
  trading_days: number;
  last_4_dates: string[];
  weekday_dates: string[];
  items: VelocityItem[];
  distinct_items: number;
}

export interface Brief {
  source: Source;
  cached?: boolean;
  date: string;
  lines: string[];
  text: string;
}

// ---------------------------------------------------------------- legacy API-only payloads

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

export interface CustomerRow {
  customer: string;
  customer_name: string;
  total: number;
  invoice_count: number;
  checks: number;
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

// ---------------------------------------------------------------- live comparison board

export type LiveMetric = "sales" | "gcs" | "avg_check" | "qty";
export type LivePeriodKey = "current" | "previous" | "last_week" | "weekday_avg";
export type LiveCompareKey = "previous" | "last_week" | "weekday_avg";

export interface LiveTotals {
  sales: number;
  gross_sales: number;
  returns_total: number;
  discounts: number;
  /** bills rung up (returns excluded) */
  gcs: number;
  return_count: number;
  /** net sales / bills */
  avg_check: number;
  qty: number;
  trading_days: number;
}

export interface LivePeriod {
  key: LivePeriodKey;
  range: Range | null;
  totals: LiveTotals;
  /** weekday_avg only */
  weekday?: string | null;
  trading_weeks?: number;
  dates?: string[];
}

export interface LiveDelta {
  abs: number | null;
  pct: number | null;
}

export interface LivePoint {
  index: number;
  label: string;
  dates: Partial<Record<LivePeriodKey, string>>;
  current: number | null;
  previous: number | null;
  last_week: number | null;
  weekday_avg: number | null;
  current_gcs: number | null;
  previous_gcs: number | null;
  last_week_gcs: number | null;
  weekday_avg_gcs: number | null;
}

export interface LiveCompare extends Base {
  as_of: string;
  days: number;
  granularity: "hour" | "day";
  periods: Record<LivePeriodKey, LivePeriod>;
  deltas: Record<LiveCompareKey, Record<LiveMetric, LiveDelta>>;
  points: LivePoint[];
  last_trading_day: string | null;
  day_close: { first_bill: string; last_bill: string } | null;
  note?: string;
}

// ------------------------------------------------------------------ costing (raw material)

/** Period totals for the Costing tab: purchases (Purchase Invoice), production consumption and output (Stock Entry). */
export interface CostingTotals {
  net_sales: number;
  raw_purchases: number;
  raw_purchase_qty: number;
  raw_purchase_items: number;
  purchases_total: number;
  purchase_invoices: number;
  purchase_days: number;
  consumed: number;
  raw_consumed: number;
  packaging_consumed: number;
  consumed_qty: number;
  consumed_items: number;
  batches: number;
  production_days: number;
  produced_value: number;
  produced_qty: number;
  produced_items: number;
  /** material consumed as % of net sales */
  material_cost_pct: number | null;
  raw_purchases_pct_of_sales: number | null;
  /** finished-goods value booked per PKR 100 of material consumed */
  yield_pct: number | null;
  avg_consumed_per_production_day: number;
  avg_consumed_per_day: number;
  /** raw material bought minus raw material used */
  purchase_gap: number;
  calendar_days: number;
}

export interface CostingStockSummary {
  raw_value: number;
  raw_items: number;
  packaging_value: number;
  total_value: number;
  raw_days_cover: number | null;
  by_warehouse: { warehouse: string; value: number; items: number }[];
}

export interface CostingKpis extends Base {
  previous_range: Range;
  current: CostingTotals;
  previous: CostingTotals;
  delta_pct: Partial<Record<keyof CostingTotals, number | null>>;
  /** ratio changes in percentage points */
  delta_points: { material_cost_pct: number | null; yield_pct: number | null; raw_purchases_pct_of_sales: number | null };
  stock: CostingStockSummary;
  health: { last_purchase_date: string | null; last_production_date: string | null; today: string };
}

export interface CostingTrendPoint {
  period: string;
  purchased: number;
  purchased_all: number;
  consumed: number;
  produced: number;
  batches: number;
}

export interface CostingTrend extends Base {
  granularity: "day" | "month";
  points: CostingTrendPoint[];
  totals: { purchased: number; purchased_all: number; consumed: number; produced: number };
}

export interface ConsumedItem {
  item_code: string;
  item_name: string;
  item_group: string;
  uom: string;
  qty: number;
  amount: number;
  rate: number;
  entries: number;
  share_pct: number;
  prev_amount: number;
  delta_pct: number | null;
  prev_rate: number | null;
  rate_change_pct: number | null;
}

export interface ProducedItem {
  item_code: string;
  item_name: string;
  item_group: string;
  uom: string;
  qty: number;
  amount: number;
  rate: number;
  entries: number;
  share_pct: number;
}

export interface CostingGroupRow {
  item_group: string;
  amount: number;
  qty: number;
  items: number;
  share_pct: number;
}

export interface CostingConsumption extends Base {
  previous_range: Range;
  total: number;
  distinct_items: number;
  by_department: { department: string; amount: number; entries: number; items: number; share_pct: number }[];
  by_group: CostingGroupRow[];
  items: ConsumedItem[];
  other_amount: number;
  produced: ProducedItem[];
  produced_total: number;
  produced_other: number;
  produced_distinct_items: number;
}

export interface PurchasedItem {
  item_code: string;
  item_name: string;
  uom: string;
  qty: number;
  amount: number;
  rate: number;
  invoices: number;
  share_pct: number;
  last_rate: number | null;
  last_date: string | null;
  prev_rate: number | null;
  rate_change_pct: number | null;
}

export interface CostingPurchases extends Base {
  previous_range: Range;
  total: number;
  raw_total: number;
  invoices: number;
  distinct_items: number;
  by_supplier: { supplier: string; amount: number; invoices: number; items: number; share_pct: number }[];
  by_group: CostingGroupRow[];
  items: PurchasedItem[];
  other_amount: number;
}

export interface StockItem {
  item_code: string;
  item_name: string;
  uom: string;
  qty: number;
  value: number;
  valuation_rate: number;
  warehouses: number;
  share_pct: number;
  used_qty: number;
  daily_use: number;
  days_cover: number | null;
}

export interface CostingStock extends Base {
  item_group: string;
  as_of: string;
  total_value: number;
  distinct_items: number;
  by_warehouse: { warehouse: string; value: number; items: number; share_pct: number }[];
  items: StockItem[];
  other_value: number;
  groups: { item_group: string; value: number; items: number }[];
}
