"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Block, Finding, Indicator, Report } from "@/lib/types";
import type { SourceInfo } from "@/lib/collectors/catalog";
import { KIND_LABELS } from "@/lib/analysis/findings";
import { isSmallSample } from "@/lib/analysis/stats";
import { fmtDate, fmtValue } from "@/lib/format";
import { cellText, Citations, inlineParts, sourceLabel } from "@/lib/render/cite";
import ChartView from "./ChartView";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="h-[420px] animate-pulse rounded-lg bg-[var(--line)]" /> });

const LEVEL: Record<string, string> = { commune: "Commune", epci: "Intercommunalité", departement: "Département", region: "Région", france: "France" };
const STATUS_FR: Record<string, string> = { ok: "Réussi", cache: "Cache", stale: "Cache périmé", partial: "Partiel", failed: "Échec", skipped: "Non exécuté" };

/** Texte avec mise en évidence `**gras**` et retours à la ligne. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, li) => (
        <Fragment key={li}>
          {li > 0 && <br />}
          {inlineParts(line).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <Fragment key={i}>{p.text}</Fragment>))}
        </Fragment>
      ))}
    </>
  );
}

export default function ReportView({ report: r, locator, freshness, catalog }: { report: Report; locator: string | null; freshness: string; catalog: Record<string, SourceInfo> }) {
  const [showSources, setShowSources] = useState(false);
  const [regen, setRegen] = useState(false);
  const [active, setActive] = useState<string>(r.sections[0]?.id ?? "");
  // Numérotation des sources dans l'ordre d'apparition (identique à l'export PDF).
  const cit = useMemo(() => new Citations(), []);
  const ev = (e: string) => r.indicators.find((i) => `${i.id}@${i.geo.level}:${i.geo.code}` === e);
  const refs = (evidence: string[] = []) => [...new Set(evidence.map(ev).filter(Boolean).map((i) => cit.cite(i!.source)))];
  const failed = r.runs.filter((x) => x.status === "failed");
  const hasFiche = r.sections.some((s) => s.id === "LFI");
  const hasCiblage = r.sections.some((s) => s.id === "CIBLAGE");

  // Partie visible (surbrillance dans la navigation).
  useEffect(() => {
    const els = r.sections.map((s) => document.getElementById(`part-${s.id}`)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActive(vis.target.id.replace(/^part-/, ""));
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [r.sections]);

  async function regenerate() {
    setRegen(true);
    const res = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r.query) });
    const d = await res.json();
    window.location.href = `/generation/${d.id}`;
  }

  const exp = (f: string, extra = "") => `/api/reports/${r.id}/export/${f}${extra}`;

  const findingsOf = (b: Extract<Block, { type: "findings" }>): Finding[] =>
    b.ids ? b.ids.map((id) => r.findings.find((f) => f.id === id)).filter((f): f is Finding => !!f) : r.findings.filter((f) => (!b.kinds || b.kinds.includes(f.kind)) && (!b.themes || b.themes.includes(f.theme)));

  const renderBlock = (b: Block, key: number) => {
    switch (b.type) {
      case "paragraph": {
        const n = refs(b.evidence);
        return (
          <p key={key} className="mb-3 leading-relaxed">
            <Rich text={b.text} />
            {n.length > 0 && <Refs n={n} onClick={() => setShowSources(true)} />}
          </p>
        );
      }
      case "heading":
        return (
          <h3 key={key} className="fiche-h">
            {b.text}
          </h3>
        );
      case "callout":
        return (
          <div key={key} className={`callout callout-${b.tone ?? "info"}`}>
            {b.title && <div className="mb-1 font-semibold">{b.title}</div>}
            <Rich text={b.text} />
          </div>
        );
      case "fieldNotes":
        return <FieldNotes key={key} id={r.id} initial={r.fieldNotes} />;
      case "fieldPlaces":
        return <FieldPlaces key={key} id={r.id} initial={r.fieldPlaces} />;
      case "targets":
        return (
          <div key={key} className="my-6 space-y-5">
            {b.items.map((t, k) => {
              const tb = r.tables.find((x) => x.id === t.tableId);
              return (
                <div key={t.tableId} className="target-card" style={{ borderTopColor: t.color }}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="display text-2xl font-bold"><span className="target-num">{k + 1}</span>{t.nom}</div>
                      {t.focus && <div className="text-sm italic text-[var(--ink-2)]">Focus possibles : {t.focus.join(", ")}</div>}
                    </div>
                    <GenerateButton codes={t.codes} kind={t.kind} />
                  </div>
                  <ul className="mt-3 list-disc space-y-1.5 pl-5 leading-relaxed">
                    {t.raisons.map((x, j) => (
                      <li key={j}>
                        <Rich text={x} />
                      </li>
                    ))}
                  </ul>
                  {tb && renderBlock({ type: "table", tableId: tb.id }, 0)}
                </div>
              );
            })}
          </div>
        );
      case "glance":
        return (
          <div key={key} className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {b.items.map((i, k) => (
              <div key={k} className={`glance glance-${i.tone ?? "neutral"}`}>
                <div className="glance-v text-2xl font-bold tabular-nums"><span>{i.value}</span></div>
                <div className="text-sm font-semibold">{i.label}</div>
                {i.detail && <div className="text-xs text-[var(--ink-2)]">{i.detail}</div>}
              </div>
            ))}
          </div>
        );
      case "actions":
        return (
          <div key={key} className="my-4 grid gap-3 md:grid-cols-2">
            {b.groups.map((g, k) => (
              <div key={k} className={`action-card ${k === 0 && g.hint === "priorité" ? "md:col-span-2 action-card-prio" : ""}`}>
                <div className="mb-1.5 font-semibold">
                  {g.title}
                  {g.hint && <span className="ml-1 font-normal text-[var(--ink-2)]">({g.hint})</span>}
                </div>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {g.items.map((i, j) => (
                    <li key={j}>
                      <Rich text={i} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        );
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
                  {i.year} [{cit.cite(i.source)}]{(isSmallSample(i) || i.status === "partial") && ", effectif faible"}
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
            <div className="max-h-[520px] overflow-auto rounded-lg border border-[var(--line)]">
              <table className="data">
                <thead>
                  <tr>
                    {t.columns.map((c) => (
                      <th key={c.key} className={`${c.align === "right" ? "r" : ""} ${c.wide ? "min-w-[9rem]" : ""}`}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((row, i) => (
                    <tr key={i} className={t.highlight?.includes(i) ? "hl" : ""}>
                      {t.columns.map((c) => (
                        <td key={c.key} className={c.align === "right" ? "r" : ""}>
                          <Rich text={cellText(row[c.key], c.unit ?? (c.key !== "indicateur" && c.key !== "annee" ? (row.unite as string | undefined) : undefined))} />
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
      case "mapPair": {
        const ms = b.mapIds.map((id) => r.maps.find((x) => x.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
        if (!ms.length) return null;
        const srcs = [...new Map(ms.flatMap((m) => m.layers.map((l) => [l.source.id + l.source.url, l.source] as const))).values()];
        return (
          <figure key={key} className="my-5">
            <figcaption className="mb-2 text-sm font-semibold">{b.title ?? ms.map((m) => m.title).join(" / ")}</figcaption>
            <div className="grid gap-4 lg:grid-cols-2">
              {ms.map((m) => (
                <div key={m.id}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-semibold text-[var(--ink-2)]">{m.period ?? m.title}</span>
                    <span className="no-print flex gap-2">
                      <a href={exp("map-png", `?id=${m.id}`)}>PNG</a>
                      <a href={exp("geojson", `?id=${m.id}`)}>GeoJSON</a>
                    </span>
                  </div>
                  <MapView map={m} height={380} />
                </div>
              ))}
            </div>
            <div className="mt-1 text-[11px] text-[var(--ink-2)]">
              Sources : {[...new Set(srcs.map((s) => `[${cit.cite(s)}]`))].join(" ")}. Fond de carte © contributeurs OpenStreetMap{ms[0].note ? ` — ${ms[0].note}` : ""}
            </div>
          </figure>
        );
      }
      case "locator":
        return locator ? (
          <Figure key={key} title={`Localisation du département ${r.commune.departement.nom}`} note="Fond : @svg-maps/france.departments (CC BY 4.0).">
            <div className="max-w-[260px]" dangerouslySetInnerHTML={{ __html: locator }} />
          </Figure>
        ) : null;
      case "note":
        return (
          <div key={key} className="my-3 rounded-lg bg-[var(--fiche-soft)] p-3 text-sm text-[var(--ink-2)]">
            <Rich text={b.text} />
          </div>
        );
      case "missing": {
        const items = r.missing.filter((m) => !b.themes.length || b.themes.includes(m.theme));
        if (!items.length) return null;
        return (
          <div key={key} className="my-4 rounded-lg border border-dashed border-[var(--line)] p-3 text-sm">
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
        const fs = findingsOf(b);
        if (!fs.length && !b.title) return null;
        if (b.style === "prose")
          return (
            <div key={key} className="my-3 space-y-3">
              {b.title && <h4 className="font-semibold text-[var(--accent)]">{b.title}</h4>}
              {fs.map((f) => (
                <p key={f.id} className="leading-relaxed">
                  {f.kind === "hypothese" && <span className="tag tag-hypothese">Hypothèse</span>}
                  <Rich text={f.text} />
                  {refs(f.evidence).length > 0 && <Refs n={refs(f.evidence)} onClick={() => setShowSources(true)} />}
                </p>
              ))}
            </div>
          );
        return (
          <div key={key} className="my-4">
            {b.title && <h4 className="mb-2 font-semibold text-[var(--accent)]">{b.title}</h4>}
            {fs.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">Aucun élément relevé automatiquement.</p>
            ) : (
              <ul className="space-y-1.5">
                {fs.map((f) => (
                  <li key={f.id} className={`finding finding-${f.kind} text-sm`}>
                    <span className={`tag tag-${f.kind}`}>{KIND_LABELS[f.kind]}</span>
                    <Rich text={f.text} />
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
            <ul className="list-disc space-y-1.5 pl-5 leading-relaxed">
              {b.items.map((i, k) => (
                <li key={k}>
                  <Rich text={i.text} />
                  {refs(i.evidence).length > 0 && <Refs n={refs(i.evidence)} onClick={() => setShowSources(true)} />}
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
  const sections = r.sections.map((s) =>
    s.id === "LFI" || s.id === "CIBLAGE" ? (
      <section key={s.id} id={`part-${s.id}`} className="card fiche mb-8 scroll-mt-20 overflow-hidden">
        <div className="fiche-band">
          <div className="fiche-kind">{s.id === "CIBLAGE" ? "Propositions de ciblage du département" : "Proposition de ciblage"}</div>
          <div className="display iso-soft mt-3 text-5xl leading-none">{s.id === "CIBLAGE" ? r.commune.departement.nom : r.commune.nom}</div>
        </div>
        <div className="p-5 md:p-8">{s.blocks.map(renderBlock)}</div>
      </section>
    ) : (
      <section key={s.id} id={`part-${s.id}`} className="card mb-6 scroll-mt-20 p-5 md:p-7">
        <h2 className="section-h mb-4 pb-2 text-2xl font-bold">
          {s.letter ? `${s.letter}. ` : ""}
          {s.title}
        </h2>
        {s.blocks.map(renderBlock)}
      </section>
    ),
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold">{hasCiblage ? r.commune.departement.nom : r.commune.nom}</h1>
          <div className="mt-1 text-sm text-[var(--ink-2)]">
            {hasCiblage ? `Ciblage du département (${r.commune.departement.code}), ${r.commune.region.nom}` : `${r.commune.departement.nom} (${r.commune.departement.code}), ${r.commune.region.nom}${r.commune.epci ? `. ${r.commune.epci.nom}` : ""}. Code INSEE ${r.commune.code}`}
          </div>
          <div className="mt-1 text-xs text-[var(--muted)]">
            Version {r.version}, générée le {fmtDate(r.updatedAt)}. Fraîcheur des données : {freshness}
          </div>
        </div>
        <div className="no-print flex flex-wrap items-center gap-2">
          {(hasFiche || hasCiblage) && (
            <a className="btn btn-primary" href={exp("pdf", "?fiche=1")}>
              {hasCiblage ? "PDF ciblage" : "PDF fiche d'action"}
            </a>
          )}
          {r.sections.some((s) => s.id === "PORTE") && (
            <a className="btn" href={exp("pdf", "?porte=1")}>
              PDF porte-à-porte
            </a>
          )}
          <a className={`btn ${hasFiche || hasCiblage ? "" : "btn-primary"}`} href={exp("pdf")}>
            PDF complet
          </a>
          <details className="menu">
            <summary className="btn">Autres formats ▾</summary>
            <div className="menu-list">
              {(hasFiche || hasCiblage) && (
                <>
                  <a href={exp("pdf", "?fiche=1&style=yonne")}>Fiche au format Word de référence (PDF)</a>
                  <a href={exp("docx", "?fiche=1")}>Fiche au format Word de référence (DOCX modifiable)</a>
                  <a href={exp("html", "?fiche=1&style=yonne")} target="_blank" rel="noreferrer">Aperçu de la fiche format Word</a>
                  <hr />
                </>
              )}
              <a href={exp("docx")}>Diagnostic complet (DOCX)</a>
              <a href={exp("csv")}>CSV des indicateurs</a>
              <a href={exp("series")}>CSV des séries</a>
              <a href={exp("json")}>JSON complet</a>
            </div>
          </details>
          <button className="btn" onClick={() => setShowSources((v) => !v)}>
            Sources
          </button>
          <button className="btn" onClick={regenerate} disabled={regen} title="Relance la collecte ; les données encore valides en cache ne sont pas retéléchargées">
            {regen ? "Relance…" : "Régénérer"}
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

      <div className="grid gap-6 lg:grid-cols-[230px_1fr]">
        <nav className="no-print lg:sticky lg:top-4 lg:self-start" aria-label="Parties du rapport">
          <ol className="card space-y-0.5 p-2 text-sm">
            {r.sections.map((s) => (
              <li key={s.id}>
                <a href={`#part-${s.id}`} className={`nav-link ${active === s.id ? "nav-active" : ""} ${s.id === "LFI" || s.id === "CIBLAGE" ? "nav-fiche" : ""}`}>
                  {s.id === "LFI" || s.id === "CIBLAGE" ? (
                    <>{s.id === "CIBLAGE" ? "Ciblage départemental" : "Fiche d'action"}</>
                  ) : (
                    <>
                      <span className="w-4 shrink-0 font-semibold text-[var(--accent)]">{s.letter}</span>
                      <span>{s.title}</span>
                    </>
                  )}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="min-w-0">{sections}</div>
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
                {catalog[s.id] && <span className="text-[var(--muted)]">, {catalog[s.id].license}</span>}
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
        Sources : {[...new Set(srcs.map((s) => `[${cite(s)}]`))].join(" ")}. Fond de carte © contributeurs OpenStreetMap{m.note ? ` — ${m.note}` : ""}
      </div>
    </figure>
  );
}

/** Retours du terrain : texte libre enregistré avec la fiche et repris dans les exports. */
function FieldNotes({ id, initial }: { id: string; initial?: Report["fieldNotes"] }) {
  const [text, setText] = useState(initial?.text ?? "");
  const [saved, setSaved] = useState(initial?.updatedAt ?? null);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [open, setOpen] = useState(!!initial?.text);
  const dirty = text !== (initial?.text ?? "") && state !== "saving";
  async function save() {
    setState("saving");
    const res = await fetch(`/api/reports/${id}/notes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) return setState("error");
    const d = await res.json();
    setSaved(d.updatedAt);
    setState("idle");
    if (initial) initial.text = text;
  }
  if (!open)
    return (
      <button className="no-print my-3 text-sm font-semibold text-[#0b6b47] underline" onClick={() => setOpen(true)}>
        + Ajouter des retours du terrain
      </button>
    );
  return (
    <div className="callout callout-terrain">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">Retours du terrain</span>
        <span className="text-xs text-[var(--ink-2)]">{saved ? `Enregistré le ${fmtDate(saved)}` : "Non enregistré"}. Les notes sont reprises dans le PDF et le Word.</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Ce que les militants locaux savent et que les données ne disent pas : quartiers, lieux de passage, horaires de marché, contacts associatifs, corrections… (**gras** possible)"
        className="no-print w-full rounded-md border border-[var(--line)] bg-white p-2 text-sm"
      />
      <div className="print-only whitespace-pre-wrap">{text}</div>
      <div className="no-print mt-2 flex items-center gap-3">
        <button className="btn btn-primary" onClick={save} disabled={!dirty}>
          {state === "saving" ? "Enregistrement…" : "Enregistrer"}
        </button>
        {state === "error" && <span className="text-sm text-[#a12a29]">Échec de l&apos;enregistrement</span>}
      </div>
    </div>
  );
}

const PLACE_TYPES = ["Marché", "Association", "Lieu de passage", "Commerce", "Équipement", "Autre"];

/**
 * Lieux d'action signalés par les militants (marchés, associations…) : les
 * données publiques en recensent mal les jours et horaires. Chaque adresse est
 * géolocalisée et rattachée à son bureau de vote à l'enregistrement.
 */
function FieldPlaces({ id, initial }: { id: string; initial?: Report["fieldPlaces"] }) {
  type P = NonNullable<Report["fieldPlaces"]>["items"][number];
  const empty = (): P => ({ type: "Marché", nom: "", horaires: "", adresse: "" });
  const [items, setItems] = useState<P[]>(initial?.items ?? []);
  const [saved, setSaved] = useState(initial?.updatedAt ?? null);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(!!initial?.items.length);
  const set = (i: number, k: keyof P, v: string) => {
    setItems((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
    setDirty(true);
  };
  async function save() {
    setState("saving");
    const res = await fetch(`/api/reports/${id}/lieux`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    if (!res.ok) return setState("error");
    const d = (await res.json()) as NonNullable<Report["fieldPlaces"]>;
    setItems(d.items);
    setSaved(d.updatedAt);
    setDirty(false);
    setState("idle");
  }
  if (!open)
    return (
      <button className="no-print my-3 text-sm font-semibold text-[var(--accent)] underline" onClick={() => (setOpen(true), setItems((x) => (x.length ? x : [empty()])))}>
        + Ajouter des lieux d&apos;action (marchés, associations, lieux de passage)
      </button>
    );
  return (
    <div className="callout callout-accent">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">Lieux d&apos;action signalés par les militants</span>
        <span className="text-xs text-[var(--ink-2)]">{saved ? `Enregistré le ${fmtDate(saved)}` : "Non enregistré"}. Repris dans le PDF et le Word.</span>
      </div>
      <div className="space-y-2">
        {items.map((p, i) => (
          <div key={i} className="grid gap-2 rounded-md border border-[var(--line)] bg-white p-2 text-sm md:grid-cols-[8rem_1fr_1fr_1.4fr_auto]">
            <select aria-label="Type" value={p.type} onChange={(e) => set(i, "type", e.target.value)} className="rounded border border-[var(--line)] p-1">
              {PLACE_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <input aria-label="Nom" placeholder="Nom (ex. marché du samedi)" value={p.nom} onChange={(e) => set(i, "nom", e.target.value)} className="rounded border border-[var(--line)] p-1" />
            <input aria-label="Jours et horaires" placeholder="Jours et horaires" value={p.horaires} onChange={(e) => set(i, "horaires", e.target.value)} className="rounded border border-[var(--line)] p-1" />
            <input aria-label="Adresse" placeholder="Adresse ou place" value={p.adresse} onChange={(e) => set(i, "adresse", e.target.value)} className="rounded border border-[var(--line)] p-1" />
            <span className="flex items-center gap-2">
              {p.bv && <span className="whitespace-nowrap text-xs font-semibold">BV {p.bv}{p.prioritaire ? " ★" : ""}</span>}
              <button aria-label="Supprimer ce lieu" className="text-[var(--danger)]" onClick={() => (setItems((xs) => xs.filter((_, j) => j !== i)), setDirty(true))}>
                ✕
              </button>
            </span>
          </div>
        ))}
      </div>
      <div className="no-print mt-2 flex flex-wrap items-center gap-3">
        <button className="btn" onClick={() => (setItems((x) => [...x, empty()]), setDirty(true))}>
          Ajouter un lieu
        </button>
        <button className="btn btn-primary" onClick={save} disabled={!dirty || state === "saving"}>
          {state === "saving" ? "Enregistrement…" : "Enregistrer"}
        </button>
        {state === "error" && <span className="text-sm text-[var(--danger)]">Échec de l&apos;enregistrement</span>}
        <span className="text-xs text-[var(--ink-2)]">★ : bureau prioritaire. Le bureau est retrouvé à partir de l&apos;adresse.</span>
      </div>
    </div>
  );
}

/** Lance la génération de la fiche détaillée d'une proposition de ciblage. */
function GenerateButton({ codes, kind }: { codes: string[]; kind: "commune" | "groupement" }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const body = kind === "commune" ? { codeInsee: codes[0], scope: "commune" } : { codeInsee: codes[0], scope: "custom", customCommunes: codes };
    const res = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json();
    if (res.ok) window.location.href = `/generation/${d.id}`;
    else setBusy(false);
  }
  return (
    <button className="btn no-print" onClick={go} disabled={busy}>
      {busy ? "Lancement…" : "Générer la fiche"}
    </button>
  );
}
