"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Block, Indicator, Report } from "@/lib/types";
import type { SourceInfo } from "@/lib/collectors/catalog";
import { KIND_LABELS } from "@/lib/analysis/findings";
import { isSmallSample } from "@/lib/analysis/stats";
import { fmtDate, fmtValue } from "@/lib/format";
import { cellText, Citations, sourceLabel } from "@/lib/render/cite";
import ChartView from "./ChartView";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="h-[460px] animate-pulse rounded-lg bg-[#eeeeec]" /> });

const LEVEL: Record<string, string> = { commune: "Commune", epci: "Intercommunalité", departement: "Département", region: "Région", france: "France" };
const STATUS_FR: Record<string, string> = { ok: "Réussi", cache: "Cache", stale: "Cache périmé", partial: "Partiel", failed: "Échec", skipped: "Non exécuté" };

export default function ReportView({ report: r, locator, freshness, catalog }: { report: Report; locator: string | null; freshness: string; catalog: Record<string, SourceInfo> }) {
  const [showSources, setShowSources] = useState(false);
  const [regen, setRegen] = useState(false);
  // Numérotation des sources dans l'ordre d'apparition (identique à l'export PDF).
  const cit = useMemo(() => new Citations(), []);
  const ev = (e: string) => r.indicators.find((i) => `${i.id}@${i.geo.level}:${i.geo.code}` === e);
  const refs = (evidence: string[] = []) => [...new Set(evidence.map(ev).filter(Boolean).map((i) => cit.cite(i!.source)))];
  const failed = r.runs.filter((x) => x.status === "failed");

  async function regenerate() {
    setRegen(true);
    const res = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r.query) });
    const d = await res.json();
    window.location.href = `/generation/${d.id}`;
  }

  const exp = (f: string, extra = "") => `/api/reports/${r.id}/export/${f}${extra}`;

  const renderBlock = (b: Block, key: number) => {
    switch (b.type) {
      case "paragraph": {
        const n = refs(b.evidence);
        return (
          <p key={key} className="mb-3 leading-relaxed">
            {b.text}
            {n.length > 0 && <Refs n={n} onClick={() => setShowSources(true)} />}
          </p>
        );
      }
      case "kpis": {
        const items = b.indicatorIds
          .map((id) => r.indicators.find((i) => i.id === id && i.geo.level === r.focus.level && (r.focus.level !== "commune" || i.geo.code === r.commune.code)))
          .filter((i): i is Indicator => !!i && i.value != null);
        if (!items.length) return null;
        return (
          <div key={key} className="my-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {items.map((i) => (
              <div key={i.id} className="card p-3" title={`${i.method ?? ""} ${i.limits ?? ""}`}>
                <div className="text-xl font-bold text-[var(--accent-strong)]">{fmtValue(i.value, i.unit)}</div>
                <div className="text-xs">{i.label}</div>
                <div className="mt-1 text-[11px] text-[var(--muted)]">
                  {i.year} · [{cit.cite(i.source)}]{(isSmallSample(i) || i.status === "partial") && " · effectif faible"}
                </div>
              </div>
            ))}
          </div>
        );
      }
      case "comparison": {
        const rows = b.indicatorIds
          .map((id) => {
            const vals = r.references.map((g) => r.indicators.find((i) => i.id === id && i.geo.level === g.level && i.geo.code === g.code));
            const base = vals.find(Boolean);
            return base && vals.some((v) => v?.value != null) ? { base, vals } : null;
          })
          .filter(Boolean) as { base: Indicator; vals: (Indicator | undefined)[] }[];
        if (!rows.length) return null;
        return (
          <Figure key={key} title={b.title ?? "Comparaison"}>
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Indicateur</th>
                    <th>Millésime</th>
                    {r.references.map((g) => (
                      <th key={g.level + g.code} className="r">
                        {g.name}
                        <div className="text-[10px] font-normal text-[var(--muted)]">{LEVEL[g.level]}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ base, vals }) => (
                    <tr key={base.id}>
                      <td title={[base.method, base.limits].filter(Boolean).join(" ")}>{base.label}</td>
                      <td>{vals[0]?.year ?? base.year}</td>
                      {vals.map((v, i) => (
                        <td key={i} className="r" title={v ? `${sourceLabel(v.source)} — ${v.source.url}` : "Donnée non disponible"}>
                          {v?.value != null ? fmtValue(v.value, v.unit) : "n.d."}
                          {v?.value != null && <sup className="ml-0.5 text-[9px] text-[var(--muted)]">{cit.cite(v.source)}</sup>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Figure>
        );
      }
      case "table": {
        const t = r.tables.find((x) => x.id === b.tableId);
        if (!t) return null;
        return (
          <Figure key={key} title={t.title} src={t.sources.map((s) => cit.cite(s))} note={t.note} download={exp("table", `?id=${t.id}`)}>
            <div className="max-h-[520px] overflow-auto">
              <table className="data">
                <thead>
                  <tr>
                    {t.columns.map((c) => (
                      <th key={c.key} className={c.align === "right" ? "r" : ""}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((row, i) => (
                    <tr key={i}>
                      {t.columns.map((c) => (
                        <td key={c.key} className={c.align === "right" ? "r" : ""}>
                          {cellText(row[c.key], c.unit ?? (c.key !== "indicateur" && c.key !== "annee" ? (row.unite as string | undefined) : undefined))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Figure>
        );
      }
      case "chart": {
        const c = r.charts.find((x) => x.id === b.chartId);
        if (!c) return null;
        return (
          <Figure key={key} title={c.title} src={c.sources.map((s) => cit.cite(s))} note={c.note}>
            <ChartView chart={c} />
          </Figure>
        );
      }
      case "map": {
        const m = r.maps.find((x) => x.id === b.mapId);
        if (!m) return null;
        const alternatives = m.group ? r.maps.filter((x) => x.group === m.group) : [m];
        return <MapBlock key={key} maps={alternatives} cite={(s) => cit.cite(s)} exp={exp} />;
      }
      case "locator":
        return locator ? (
          <Figure key={key} title={`Localisation du département ${r.commune.departement.nom}`} note="Fond : @svg-maps/france.departments (CC BY 4.0).">
            <div className="max-w-[260px]" dangerouslySetInnerHTML={{ __html: locator }} />
          </Figure>
        ) : null;
      case "note":
        return (
          <div key={key} className="my-3 rounded-lg bg-[#f6f6f4] p-3 text-sm text-[var(--ink-2)]">
            {b.text}
          </div>
        );
      case "missing": {
        const items = r.missing.filter((m) => !b.themes.length || b.themes.includes(m.theme));
        if (!items.length) return null;
        return (
          <div key={key} className="my-4 rounded-lg border border-dashed border-[#c3c2b7] p-3 text-sm">
            <strong>Données manquantes ou non intégrées</strong>
            <ul className="mt-1 list-disc pl-5">
              {items.map((m, i) => (
                <li key={i}>
                  {m.label} — <span className="text-[var(--muted)]">{m.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      }
      case "findings": {
        const fs = r.findings.filter((f) => (!b.kinds || b.kinds.includes(f.kind)) && (!b.themes || b.themes.includes(f.theme)));
        if (!fs.length && !b.title) return null;
        return (
          <div key={key} className="my-4">
            {b.title && <h4 className="mb-2 font-semibold text-[var(--accent)]">{b.title}</h4>}
            {fs.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">Aucun élément relevé automatiquement.</p>
            ) : (
              <ul className="divide-y divide-[#f0efec]">
                {fs.map((f) => (
                  <li key={f.id} className="py-1.5 text-sm">
                    <span className={`tag tag-${f.kind}`}>{KIND_LABELS[f.kind]}</span>
                    {f.text}
                    {refs(f.evidence).length > 0 && <Refs n={refs(f.evidence)} onClick={() => setShowSources(true)} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      }
      case "list":
        return (
          <div key={key} className="my-4">
            {b.title && <h4 className="mb-2 font-semibold text-[var(--accent)]">{b.title}</h4>}
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {b.items.map((i, k) => (
                <li key={k}>
                  {i.text}
                  {i.url && (
                    <>
                      {" — "}
                      <a href={i.url} target="_blank" rel="noreferrer">
                        {i.url}
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
    }
  };

  // Rendu des sections avant la liste des sources pour une numérotation cohérente.
  const sections = r.sections.map((s) => (
    <section key={s.id} id={`part-${s.id}`} className="card mb-6 scroll-mt-4 p-5 md:p-7">
      <h2 className="mb-4 border-b-2 border-[#2a78d6] pb-2 text-xl font-bold text-[var(--accent-strong)]">
        {s.letter ? `${s.letter}. ` : ""}
        {s.title}
      </h2>
      {s.blocks.map(renderBlock)}
    </section>
  ));

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-[var(--ink-2)]">Diagnostic territorial</div>
          <h1 className="text-3xl font-bold text-[var(--accent-strong)]">{r.commune.nom}</h1>
          <div className="text-sm text-[var(--ink-2)]">
            {r.commune.departement.nom} ({r.commune.departement.code}) · {r.commune.region.nom}
            {r.commune.epci && ` · ${r.commune.epci.nom}`} · INSEE {r.commune.code}
          </div>
          <div className="mt-1 text-xs text-[var(--muted)]">
            Version {r.version} générée le {fmtDate(r.updatedAt)} · Fraîcheur : {freshness}
          </div>
        </div>
        <div className="no-print flex flex-wrap gap-2">
          {r.sections.some((s) => s.id === "LFI") && (
            <a className="btn btn-primary" href={exp("pdf", "?fiche=1")}>
              PDF fiche d&apos;action
            </a>
          )}
          <a className="btn btn-primary" href={exp("pdf")}>
            PDF complet
          </a>
          <a className="btn" href={exp("docx")}>
            DOCX
          </a>
          <a className="btn" href={exp("csv")}>
            CSV indicateurs
          </a>
          <a className="btn" href={exp("series")}>
            CSV séries
          </a>
          <a className="btn" href={exp("json")}>
            JSON
          </a>
          <button className="btn" onClick={() => setShowSources((v) => !v)}>
            Sources et méthodologie
          </button>
          <button className="btn" onClick={regenerate} disabled={regen} title="Relance la collecte ; les données encore valides en cache ne sont pas retéléchargées">
            {regen ? "…" : "Régénérer"}
          </button>
        </div>
      </div>

      {(r.warnings.length > 0 || failed.length > 0) && (
        <div className="mb-6 rounded-lg border-l-4 border-[#eda100] bg-[#fff7e6] p-3 text-sm">
          {r.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
          {failed.length > 0 && (
            <div className="mt-1 text-[var(--ink-2)]">
              Sources en échec : {[...new Set(failed.map((f) => f.name))].join(" ; ")}.{" "}
              <button className="underline" onClick={() => setShowSources(true)}>
                Détails
              </button>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav className="no-print lg:sticky lg:top-4 lg:self-start">
          <ol className="card space-y-1 p-3 text-sm">
            {r.sections.map((s) => (
              <li key={s.id}>
                <a href={`#part-${s.id}`} className="block rounded px-2 py-1 text-[var(--ink)] no-underline hover:bg-[var(--accent-soft)]">
                  {s.letter && <span className="font-semibold text-[var(--accent)]">{s.letter}.</span>} {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div>{sections}</div>
      </div>

      {showSources && (
        <aside className="fixed inset-y-0 right-0 z-[1000] w-full max-w-xl overflow-y-auto border-l border-[var(--line)] bg-white p-5 shadow-2xl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold">Sources et méthodologie</h2>
            <button className="btn" onClick={() => setShowSources(false)}>
              Fermer
            </button>
          </div>
          <p className="mb-3 text-sm text-[var(--ink-2)]">
            Calculs déterministes ; aucune valeur estimée en cas d&apos;absence (« n.d. »). Écart significatif : ≥ 2 points et ≥ 10 % en relatif pour un taux,
            ≥ 10 % sinon. Valeur atypique : score z robuste ≥ 2 parmi les communes comparables. Rédaction : {r.narrativeEngine}.
          </p>
          <h3 className="mb-2 font-semibold">Références citées</h3>
          <ol className="mb-5 list-decimal space-y-1 pl-5 text-xs">
            {cit.all().map((s, i) => (
              <li key={i}>
                {sourceLabel(s)} — consulté le {fmtDate(s.retrievedAt)}
                {catalog[s.id] && <span className="text-[var(--muted)]"> · {catalog[s.id].license}</span>}
                <br />
                <a href={s.url} target="_blank" rel="noreferrer" className="break-all">
                  {s.url.length > 140 ? s.url.slice(0, 137) + "…" : s.url}
                </a>
              </li>
            ))}
          </ol>
          <h3 className="mb-2 font-semibold">Journal de collecte</h3>
          <table className="data mb-5">
            <thead>
              <tr>
                <th>Source</th>
                <th>Statut</th>
                <th className="r">Req.</th>
              </tr>
            </thead>
            <tbody>
              {r.runs.map((x, i) => (
                <tr key={i} title={x.message}>
                  <td>
                    {x.name}
                    <div className="text-[10px] text-[var(--muted)]">
                      {x.step}
                      {x.message ? ` — ${x.message}` : ""}
                    </div>
                  </td>
                  <td className={x.status === "failed" ? "text-[#a12a29]" : x.status === "ok" || x.status === "cache" ? "text-[#0b6b47]" : "text-[#8a5300]"}>{STATUS_FR[x.status]}</td>
                  <td className="r">
                    {x.requests}
                    {x.fromCache ? ` (${x.fromCache} cache)` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="mb-2 font-semibold">Catalogue des sources</h3>
          <ul className="space-y-2 text-xs">
            {Object.values(catalog).map((s) => (
              <li key={s.id}>
                <strong>{s.name}</strong> ({s.producer}) — {s.access} Licence : {s.license}. <span className="text-[var(--muted)]">Limites : {s.limits}</span>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}

function Refs({ n, onClick }: { n: number[]; onClick: () => void }) {
  return (
    <button onClick={onClick} className="ml-1 align-super text-[10px] text-[var(--muted)] hover:text-[var(--accent)]" title="Voir les sources">
      {n.map((x) => `[${x}]`).join("")}
    </button>
  );
}

function Figure({ title, children, src, note, download }: { title: string; children: React.ReactNode; src?: number[]; note?: string; download?: string }) {
  return (
    <figure className="my-5">
      <figcaption className="mb-2 flex items-center justify-between gap-2 text-sm font-semibold">
        <span>{title}</span>
        {download && (
          <a href={download} className="no-print shrink-0 text-xs font-normal">
            CSV
          </a>
        )}
      </figcaption>
      {children}
      {(src?.length || note) && (
        <div className="mt-1 text-[11px] text-[var(--ink-2)]">
          {src?.length ? `Sources : ${[...new Set(src)].map((x) => `[${x}]`).join(" ")}` : ""}
          {note ? ` — ${note}` : ""}
        </div>
      )}
    </figure>
  );
}

function MapBlock({ maps, cite, exp }: { maps: Report["maps"]; cite: (s: Report["maps"][number]["layers"][number]["source"]) => number; exp: (f: string, extra?: string) => string }) {
  const [idx, setIdx] = useState(0);
  const m = maps[idx];
  const srcs = [...new Map(m.layers.map((l) => [l.source.id + l.source.url, l.source])).values()];
  return (
    <figure className="my-5">
      <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
        <span>{m.title}</span>
        <span className="no-print flex items-center gap-2 text-xs font-normal">
          {maps.length > 1 && (
            <select value={idx} onChange={(e) => setIdx(Number(e.target.value))} className="rounded border border-[var(--line)] px-1 py-0.5" aria-label="Période">
              {maps.map((x, i) => (
                <option key={x.id} value={i}>
                  {x.period ?? x.title}
                </option>
              ))}
            </select>
          )}
          <a href={exp("map-png", `?id=${m.id}`)}>PNG</a>
          <a href={exp("map-svg", `?id=${m.id}`)}>SVG</a>
          <a href={exp("geojson", `?id=${m.id}`)}>GeoJSON</a>
        </span>
      </figcaption>
      <MapView key={m.id} map={m} />
      <div className="mt-1 text-[11px] text-[var(--ink-2)]">
        Sources : {srcs.map((s) => `[${cite(s)}]`).join(" ")} · Fond de carte © contributeurs OpenStreetMap{m.note ? ` — ${m.note}` : ""}
      </div>
    </figure>
  );
}
