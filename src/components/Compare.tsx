"use client";

import { Fragment, type ReactNode } from "react";
import type { CompareCol } from "@/lib/report/compare";
import { inlineParts } from "@/lib/render/cite";
import ChartView from "./ChartView";
import PresenceBars from "./PresenceBars";

function Rich({ text }: { text: string }) {
  return <>{inlineParts(text).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <Fragment key={i}>{p.text}</Fragment>))}</>;
}

const labelsOf = (cols: CompareCol[], pick: (c: CompareCol) => Record<string, unknown>) => {
  const out: string[] = [];
  for (const c of cols) for (const k of Object.keys(pick(c))) if (!out.includes(k)) out.push(k);
  return out;
};

/** Fiches côte à côte : une colonne par commune, les mêmes lignes alignées. */
export default function Compare({ cols }: { cols: CompareCol[] }) {
  if (cols.length < 2)
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="mb-3 text-2xl font-extrabold">Comparer des communes</h1>
        <p className="text-[var(--ink-2)]">
          Choisissez 2 ou 3 fiches commune dans la liste « Fiches déjà générées » de la page d&apos;accueil (cases à cocher), puis « Comparer ». Les fiches doivent avoir été générées au préalable.
        </p>
        <a className="btn mt-4 inline-block" href="/">
          Retour à l&apos;accueil
        </a>
      </main>
    );
  const n = cols.length;
  const grid = { gridTemplateColumns: `minmax(9rem, 13rem) repeat(${n}, minmax(0, 1fr))` };
  const gridN = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <section className="mt-8">
      <h2 className="mb-3 border-b-2 border-[var(--accent)] pb-1 text-lg font-extrabold text-[var(--accent)]">{title}</h2>
      {children}
    </section>
  );
  const Rows = ({ labels, cell }: { labels: string[]; cell: (c: CompareCol, l: string) => ReactNode }) => (
    <div className="overflow-x-auto">
      <div className="grid min-w-[640px] text-sm" style={grid}>
        {labels.map((l, i) => (
          <Fragment key={l}>
            <div className={`py-2 pr-3 font-semibold ${i % 2 ? "" : "bg-[var(--accent-soft)]/40"}`}>{l}</div>
            {cols.map((c) => (
              <div key={c.id} className={`px-3 py-2 tabular-nums ${i % 2 ? "" : "bg-[var(--accent-soft)]/40"}`}>
                {cell(c, l)}
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
  const glanceLabels = labelsOf(cols, (c) => c.glance);
  const profilLabels = labelsOf(cols, (c) => c.profil);
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-extrabold">Comparaison</h1>
        <a href="/" className="text-sm">
          Changer la sélection
        </a>
      </div>
      <div className="sticky top-0 z-10 -mx-4 bg-[var(--bg)] px-4 py-2">
        <div className="grid gap-3" style={grid}>
          <div />
          {cols.map((c) => (
            <div key={c.id}>
              <a href={`/rapport/${c.id}`} className="text-lg font-extrabold">
                {c.nom}
              </a>
              <div className="text-xs text-[var(--ink-2)]">
                {c.departement}, fiche du {new Date(c.updatedAt).toLocaleDateString("fr-FR")}
              </div>
            </div>
          ))}
        </div>
      </div>

      {glanceLabels.length > 0 && (
        <Section title="Chiffres clés">
          <Rows
            labels={glanceLabels}
            cell={(c, l) =>
              c.glance[l] ? (
                <>
                  <span className="text-base font-bold text-[var(--accent)]">{c.glance[l].value}</span>
                  {c.glance[l].detail && <span className="block text-xs text-[var(--ink-2)]">{c.glance[l].detail}</span>}
                </>
              ) : (
                <span className="text-[var(--muted)]">—</span>
              )
            }
          />
        </Section>
      )}

      {cols.some((c) => c.synth.length) && (
        <Section title="En résumé">
          <div className="grid gap-4" style={gridN}>
            {cols.map((c) => (
              <ul key={c.id} className="list-disc space-y-1.5 pl-5 text-sm">
                {c.synth.map((t, i) => (
                  <li key={i}>
                    <Rich text={t} />
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </Section>
      )}

      {profilLabels.length > 0 && (
        <Section title="Profil sociodémographique">
          <Rows
            labels={profilLabels}
            cell={(c, l) =>
              c.profil[l] ? (
                <>
                  <span className="font-semibold">{c.profil[l].value}</span>
                  {c.profil[l].dep && <span className="ml-1 text-xs text-[var(--ink-2)]">(dép. {c.profil[l].dep})</span>}
                </>
              ) : (
                <span className="text-[var(--muted)]">—</span>
              )
            }
          />
        </Section>
      )}

      {cols.some((c) => c.chart) && (
        <Section title="Européennes 2024">
          <div className="grid gap-6" style={gridN}>
            {cols.map((c) => (
              <div key={c.id}>{c.chart ? <ChartView chart={c.chart} /> : <p className="text-sm text-[var(--muted)]">Non disponible</p>}</div>
            ))}
          </div>
        </Section>
      )}

      {cols.some((c) => c.presence) && (
        <Section title="Présence militante LFI">
          <div className="grid gap-4" style={gridN}>
            {cols.map((c) => (
              <div key={c.id}>{c.presence ? <PresenceBars b={c.presence} compact /> : <p className="text-sm text-[var(--muted)]">Bilan non déposé</p>}</div>
            ))}
          </div>
        </Section>
      )}

      {cols.some((c) => c.bureaux.length) && (
        <Section title="Bureaux de vote prioritaires">
          <div className="grid gap-4" style={gridN}>
            {cols.map((c) => (
              <ul key={c.id} className="space-y-1.5 text-sm">
                {c.bureaux.map((b) => (
                  <li key={b.bv}>
                    <strong>Bureau {b.bv}</strong>
                    {b.lieu ? ` (${b.lieu})` : ""} : vote LFI {b.lfi}
                    {b.abst ? `, ${b.abst} n'ont pas voté` : ""}
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </Section>
      )}
    </main>
  );
}
