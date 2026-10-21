"use client";

import { useState } from "react";
import { presenceRef, presenceScale, presenceSub, presenceValue, type PresenceBlock, type PresenceMode } from "@/lib/render/presence";

/** Encart « Présence militante LFI », avec bascule Nombre / Pour 100 inscrits. */
export default function PresenceBars({ b, compact = false }: { b: PresenceBlock; compact?: boolean }) {
  const [mode, setMode] = useState<PresenceMode>("nombre");
  return (
    <figure className="my-5 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-sm font-extrabold text-[var(--accent)]">{compact ? "" : b.title}</figcaption>
        <div className="no-print flex gap-1" role="group" aria-label="Unité">
          {(
            [
              ["nombre", "Nombre"],
              ["ratio", "Pour 100 inscrits"],
            ] as const
          ).map(([m, l]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${mode === m ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)] text-[var(--ink-2)]"}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        {b.rows.map((r) => {
          const s = presenceScale(r);
          return (
            <div key={r.label} className={`grid items-center gap-3 ${compact ? "grid-cols-[minmax(0,7rem)_1fr_auto]" : "grid-cols-[minmax(0,9.5rem)_1fr_auto] sm:grid-cols-[12rem_1fr_7rem]"}`}>
              <div className="min-w-0">
                <div className="text-sm font-semibold leading-tight">{r.label}</div>
                <div className="text-xs text-[var(--ink-2)]">{presenceSub(r, mode)}</div>
              </div>
              <div className="relative h-3 rounded bg-[var(--accent-soft)]" title={presenceRef(r, mode)}>
                <div className="absolute inset-y-0 left-0 rounded bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${(100 * s.fill).toFixed(1)}%` }} />
                <div className="absolute -inset-y-1 w-[3px] -translate-x-1/2 bg-[var(--mark)]" style={{ left: `${(100 * s.tick).toFixed(1)}%` }} />
              </div>
              <div className="text-right">
                <div className="text-lg font-bold tabular-nums text-[var(--accent)]">{presenceValue(r, mode)}</div>
                <div className="text-[11px] text-[var(--ink-2)]">{presenceRef(r, mode)}</div>
              </div>
            </div>
          );
        })}
      </div>
      {b.note && <p className="mt-3 text-xs text-[var(--ink-2)]">{b.note}</p>}
    </figure>
  );
}
