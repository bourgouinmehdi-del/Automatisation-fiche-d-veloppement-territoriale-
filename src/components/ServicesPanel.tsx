"use client";

import { useState } from "react";
import type { Block } from "@/lib/types";
import { ICONS } from "@/lib/render/icons";
import { fmtNumber } from "@/lib/format";

type B = Extract<Block, { type: "services" }>;
const km = (v: number) => (v < 0.1 ? "sur place" : `${fmtNumber(v, v < 10 ? 1 : 0)} km`);
export const NIVEAU: Record<string, { txt: string; cls: string }> = {
  mieux: { txt: "Mieux desservie", cls: "text-[#1b7f55]" },
  comme: { txt: "Comme les communes semblables", cls: "text-[var(--ink-2)]" },
  moins: { txt: "Moins bien desservie", cls: "text-[var(--mark)] font-semibold" },
};

function Icon({ cat }: { cat: string }) {
  return <span className="inline-flex shrink-0 text-[var(--accent)]" dangerouslySetInnerHTML={{ __html: ICONS[cat] ?? "" }} />;
}

/** Accès aux services : « Points faibles » (par défaut) ou « Par catégorie ». */
export default function ServicesPanel({ b }: { b: B }) {
  const [mode, setMode] = useState<"faibles" | "cats">(b.faibles.length ? "faibles" : "cats");
  return (
    <figure className="my-5 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-sm font-extrabold text-[var(--accent)]">{b.title}</figcaption>
        <div className="no-print flex gap-1" role="group" aria-label="Lecture">
          {(
            [
              ["faibles", "Points faibles"],
              ["cats", "Par catégorie"],
            ] as const
          ).map(([m, l]) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={`rounded-full border px-2.5 py-0.5 text-xs ${mode === m ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)] text-[var(--ink-2)]"}`}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {mode === "faibles" ? (
        b.faibles.length ? (
          <ul className="space-y-2 text-sm">
            {b.faibles.map((f) => (
              <li key={f.label} className="flex items-center gap-2">
                <Icon cat={f.cat} />
                <span className="font-semibold">{f.label}</span>
                <span className="text-[var(--ink-2)]">
                  : le plus proche à {km(f.km)}, {f.medKm < 0.1 ? "alors que la plupart des communes de cette taille en ont un sur place" : `contre ${km(f.medKm)} en général pour une commune de cette taille`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--ink-2)]">Aucun service nettement moins accessible que dans les communes de taille comparable.</p>
        )
      ) : (
        <div className="divide-y divide-[var(--line)] text-sm">
          {b.cats.map((c) => (
            <details key={c.cat} className="py-2">
              <summary className="flex cursor-pointer list-none items-center gap-2">
                <Icon cat={c.cat} />
                <span className="font-semibold">{c.label}</span>
                <span className={`ml-auto ${NIVEAU[c.niveau].cls}`}>{NIVEAU[c.niveau].txt}</span>
              </summary>
              <ul className="mt-1.5 space-y-0.5 pl-7 text-[var(--ink-2)]">
                {c.details.map((d) => (
                  <li key={d.label}>
                    {d.label} : {d.surPlace ? "dans la commune" : `à ${km(d.km)}`} (communes semblables : {km(d.medKm)})
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-[var(--ink-2)]">{b.note}</p>
    </figure>
  );
}
