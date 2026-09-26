"use client";

import dynamic from "next/dynamic";

// The dashboard restores tab/date/theme preferences from localStorage, so it is
// rendered on the client only (no server markup to mismatch against).
const Dashboard = dynamic(() => import("./Dashboard"), {
  ssr: false,
  loading: () => (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-4 sm:px-6">
      <div className="skeleton h-10 w-64" />
      <div className="skeleton h-12 w-full" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-24" />
        ))}
      </div>
    </div>
  ),
});

export default function DashboardLoader() {
  return <Dashboard />;
}
