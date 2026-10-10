"use client";

import type { Range } from "@/lib/types";
import CostBoard from "../CostBoard";
import DeclineBoard from "../DeclineBoard";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

/** Sales decline & cost increase: where sales are slipping and where costs are climbing. */
export default function DeclineTab({ range, refreshKey, onRetry }: Props) {
  return (
    <div className="flex flex-col gap-4">
      <DeclineBoard range={range} refreshKey={refreshKey} onRetry={onRetry} />
      <CostBoard range={range} refreshKey={refreshKey} onRetry={onRetry} />
    </div>
  );
}
