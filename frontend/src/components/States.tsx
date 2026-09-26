"use client";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function ChartSkeleton({ height = 260 }: { height?: number }) {
  return (
    <div className="flex flex-col gap-3" style={{ height }}>
      <Skeleton className="h-full w-full" />
    </div>
  );
}

export function EmptyState({ title = "No data for this range", hint }: { title?: string; hint?: string }) {
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-1 text-center">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-3">
        <path d="M4 19h16M6 15V9m4 6V5m4 10v-4m4 4V7" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 text-center">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-bad">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4m0 4h.01" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-medium text-ink">Could not load data</p>
      <p className="max-w-md text-xs text-ink-3">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-1 rounded-md border border-line px-3 py-1 text-xs font-medium text-ink-2 hover:bg-surface-2">
          Retry
        </button>
      )}
    </div>
  );
}
