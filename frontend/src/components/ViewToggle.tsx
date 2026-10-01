"use client";

/** Small segmented control used inside card headers to switch between views. */
export default function ViewToggle<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex rounded-md border border-line bg-surface p-0.5">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)} className={`rounded px-2 py-0.5 text-[11px] font-medium ${value === o.id ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
