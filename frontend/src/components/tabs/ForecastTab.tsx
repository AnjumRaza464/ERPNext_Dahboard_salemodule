"use client";

import type { Range } from "@/lib/types";
import NextDayPlan from "../NextDayPlan";

interface Props {
  range: Range;
  refreshKey: number;
  onRetry: () => void;
}

/** Production forecast: how much of each product to make. The plan has its own date picker, independent of the range filter. */
export default function ForecastTab({ refreshKey }: Props) {
  return (
    <div className="flex flex-col gap-4">
      <NextDayPlan refreshKey={refreshKey} source="sales" />
      <NextDayPlan refreshKey={refreshKey} source="production" />
    </div>
  );
}
