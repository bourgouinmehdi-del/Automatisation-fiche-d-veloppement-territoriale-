"use client";

import { useState } from "react";
import type { Block } from "@/lib/types";
import { ICONS } from "@/lib/render/icons";

type B = Extract<Block, { type: "services" }>;
export const NIVEAU: Record<string, { txt: string; cls: string }> = {
  mieux: { txt: "Mieux desservie", cls: "text-[#1b7f55]" },
  comme: { txt: "Dans la moyenne du département", cls: "text-[var(--ink-2)]" },
  moins: { txt: "Moins bien desservie", cls: "text-[var(--mark)] font-semibold" },
};

function Icon({ cat }: { cat: string }) {
  return <span className="inline-flex shrink-0 text-[var(--accent)]" dangerouslySetInnerHTML={{ __html: ICONS[cat] ?? "" }} />;
}

/** Accès aux services : « Points faibles » (par défaut) ou « Par catégorie ». */
export default function ServicesPanel({ b }: { b: B }) {
  const [mode, setMode] = useState<"faibles" | "cats">(b.faibles.length || b.enDessous?.length ? "faibles" : "cats");
  const dessous = b.enDessous ?? [];
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
        b.faibles.length || dessous.length ? (
          <div className="space-y-3 text-sm">
            {(
              [
                [b.faibles, ""],
                [dessous, b.faibles.length ? "Un peu en dessous de l'habitant moyen du département" : "Aucun service très en retard, mais plusieurs un peu en dessous de l'habitant moyen du département :"],
              ] as const
            )
              .filter(([xs]) => xs.length)
              .map(([xs, titre]) => (
                <div key={titre || "faibles"}>
                  {titre && <p className="mb-1.5 text-[var(--ink-2)]">{titre}</p>}
                  <ul className="space-y-2">
                    {xs.map((f) => (
                      <li key={f.label} className="flex items-center gap-2">
                        <Icon cat={f.cat} />
                        <span className="font-semibold">{f.label}</span>
                        <span className="text-[var(--ink-2)]">: {f.txt}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--ink-2)]">Aucun service moins accessible que pour l'habitant moyen du département.</p>
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
                    {d.label} : {d.txt}
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
