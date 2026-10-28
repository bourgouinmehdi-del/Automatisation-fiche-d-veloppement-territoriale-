"use client";

import type { Block } from "@/lib/types";
import { ICONS } from "@/lib/render/icons";
import { niveauAcces } from "@/lib/render/indice";

type B = Extract<Block, { type: "services" }>;

function Pastille({ v, big = false }: { v: number; big?: boolean }) {
  const n = niveauAcces(v);
  return (
    <span className={`inline-block whitespace-nowrap rounded-full font-semibold ${big ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs"}`} style={{ background: n.bg, color: n.fg }}>
      {n.txt}
    </span>
  );
}

function Icon({ cat }: { cat: string }) {
  return <span className="inline-flex shrink-0 text-[var(--accent)]" dangerouslySetInnerHTML={{ __html: ICONS[cat] ?? "" }} />;
}

function Ligne({ f }: { f: { cat: string; label: string; txt: string } }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5">
        <Icon cat={f.cat} />
      </span>
      <span>
        <span className="font-semibold">{f.label}</span>
        <span className="text-[var(--ink-2)]"> : {f.txt}</span>
      </span>
    </li>
  );
}

/**
 * Accès aux services : un seul tableau par thème (pastille de couleur ; clic sur une ligne pour le
 * détail service par service), puis les points faibles.
 */
export default function ServicesPanel({ b }: { b: B }) {
  const dessous = b.enDessous ?? [];
  const themes = b.indice?.gammes ?? b.cats.map((c) => ({ cat: c.cat, label: c.label, exemples: "", value: c.niveau === "moins" ? 80 : c.niveau === "mieux" ? 120 : 100 }));
  return (
    <figure className="my-5 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
      <figcaption className="mb-3 text-sm font-extrabold text-[var(--accent)]">{b.title}</figcaption>
      {b.indice && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span>Accès aux services, comparé {b.indice.ref === "France" ? "à l'habitant moyen en France" : "à l'habitant moyen du département"} :</span>
          <Pastille v={b.indice.global} big />
        </div>
      )}
      <div className="divide-y divide-[var(--line)] rounded-md border border-[var(--line)] text-sm">
        {themes.map((g) => {
          const det = b.cats.find((c) => c.cat === g.cat)?.details ?? [];
          return (
            <details key={g.label} className="group px-3 py-2">
              <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,13rem)_auto_1fr_auto] items-center gap-x-3">
                <span className="flex items-center gap-1.5 font-semibold text-[var(--ink)]">
                  {g.cat && <Icon cat={g.cat} />}
                  {g.label}
                </span>
                <Pastille v={g.value} />
                <span className="truncate text-xs text-[var(--ink-2)]" title={g.exemples}>
                  {g.exemples}
                </span>
                <span className="text-xs text-[var(--ink-2)] group-open:rotate-90" aria-hidden>
                  ▸
                </span>
              </summary>
              <ul className="mt-1.5 space-y-0.5 pl-7 text-[var(--ink-2)]">
                {det.map((d) => (
                  <li key={d.label}>
                    {d.label} : {d.txt}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-[var(--ink-2)]">Cliquer sur un thème pour le détail service par service.</p>
      {(b.faibles.length > 0 || dessous.length > 0) && (
        <div className="mt-4 space-y-3 text-sm">
          {b.faibles.length > 0 && (
            <div>
              <p className="mb-1.5 font-semibold text-[var(--accent)]">Points faibles</p>
              <ul className="space-y-2">
                {b.faibles.map((f) => (
                  <Ligne key={f.label} f={f} />
                ))}
              </ul>
            </div>
          )}
          {dessous.length > 0 && (
            <div>
              <p className="mb-1.5 font-semibold text-[var(--accent)]">{b.faibles.length ? "Un peu en dessous de la moyenne" : "Pas de service très en retard, mais plusieurs un peu en dessous de la moyenne"}</p>
              <ul className="space-y-2">
                {dessous.map((f) => (
                  <Ligne key={f.label} f={f} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-[var(--ink-2)]">{b.note}</p>
    </figure>
  );
}
