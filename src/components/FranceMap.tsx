"use client";

import { useState } from "react";
import data from "@/lib/data/france-departements.json";

/**
 * Carte des départements de métropole (contours simplifiés, IGN via france-geojson, Licence Ouverte) :
 * un clic choisit le département à cibler ; le département de la commune choisie est mis en évidence.
 */
const OUTRE_MER = [
  { code: "971", nom: "Guadeloupe" },
  { code: "972", nom: "Martinique" },
  { code: "973", nom: "Guyane" },
  { code: "974", nom: "La Réunion" },
  { code: "976", nom: "Mayotte" },
];

export default function FranceMap({ selected, onPick }: { selected: string | null; onPick: (code: string) => void }) {
  const [hover, setHover] = useState<{ code: string; nom: string } | null>(null);
  const cur = hover ?? (selected ? (data.departements.find((d) => d.code === selected) ?? OUTRE_MER.find((d) => d.code === selected) ?? null) : null);
  return (
    <div>
      <svg viewBox={`0 0 ${data.w} ${data.h}`} className="mx-auto block h-auto w-full max-w-md" role="img" aria-label="Carte des départements : cliquer pour choisir">
        {data.departements.map((d) => {
          const on = d.code === selected;
          const hov = hover?.code === d.code;
          return (
            <path
              key={d.code}
              d={d.d}
              role="button"
              tabIndex={0}
              aria-label={`${d.nom} (${d.code})`}
              onMouseEnter={() => setHover(d)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(d)}
              onBlur={() => setHover(null)}
              onClick={() => onPick(d.code)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPick(d.code)}
              className="cursor-pointer outline-none transition-colors"
              style={{ fill: on ? "var(--accent)" : hov ? "var(--accent-soft)" : "var(--track)", stroke: on || hov ? "var(--accent)" : "var(--surface)", strokeWidth: on ? 1.4 : 0.9 }}
            />
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-xs">
        {OUTRE_MER.map((d) => (
          <button key={d.code} type="button" onClick={() => onPick(d.code)} aria-pressed={selected === d.code} className={`rounded-full border px-2 py-0.5 ${selected === d.code ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)] text-[var(--ink-2)]"}`}>
            {d.nom}
          </button>
        ))}
      </div>
      <p className="mt-2 h-5 text-center text-sm text-[var(--ink-2)]">{cur ? `${cur.nom} (${cur.code})` : "Cliquer sur un département pour préparer son ciblage"}</p>
    </div>
  );
}
