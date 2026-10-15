"use client";

import { useApi } from "@/hooks/useApi";
import type { Range, StockTracking } from "@/lib/types";
import PurchaseAnalysis from "../PurchaseAnalysis";
import StockEntriesTable from "../StockEntriesTable";
import StockItemsTable from "../StockItemsTable";
import StockMovement from "../StockMovement";
import StockOverview from "../StockOverview";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

/** Stock tracking: where stock stood at the start of the range, what moved, where it stands now, item by item. */
export default function StockTrackingTab({ range, refreshKey, onRetry }: Props) {
  // one payload feeds every card on this tab
  const q = useApi<StockTracking>("/api/stock/tracking", range, refreshKey);
  return (
    <div className="flex flex-col gap-4">
      <StockOverview q={q} range={range} onRetry={onRetry} />
      <StockMovement q={q} range={range} onRetry={onRetry} />
      {/* purchases have their own payload (Purchase Invoice lines) and weekday filter */}
      <PurchaseAnalysis range={range} refreshKey={refreshKey} onRetry={onRetry} />
      <StockItemsTable q={q} range={range} onRetry={onRetry} />
      <StockEntriesTable q={q} range={range} onRetry={onRetry} />
    </div>
  );
}
