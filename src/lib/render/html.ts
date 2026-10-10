import { SOURCES } from "../collectors/catalog";
import { KIND_LABELS, THEME_LABELS } from "../analysis/findings";
import { isSmallSample } from "../analysis/stats";
import { fmtDate, fmtValue } from "../format";
import type { Block, DataTable, Finding, Indicator, Report, SourceRef } from "../types";
import { chartSvg, hasLocator, locatorSvg, mapSvg } from "./svg";
import { cellText, Citations, sourceLabel } from "./cite";

export { cellText, Citations, sourceLabel };

/**
 * Rendu HTML autonome du rapport (sans JavaScript), conçu pour l'impression
 * et la conversion PDF : couverture, sommaire, parties A à I, notes
 * méthodologiques, journal de collecte et bibliographie des sources.
 */

export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const LEVEL_LABEL: Record<string, string> = { commune: "Commune", epci: "Intercommunalité", departement: "Département", region: "Région", france: "France", bureau_vote: "Bureau de vote" };

function tableHtml(t: DataTable, cit: Citations) {
  const refs = t.sources.map((s) => cit.cite(s));
  const rowUnit = (r: Record<string, string | number | null>) => (r.unite as string | undefined) ?? undefined;
  return `<figure class="tbl"><figcaption>${esc(t.title)}</figcaption><table><thead><tr>${t.columns.map((c) => `<th class="${c.align === "right" ? "r" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${t.rows
    .map(
      (r) =>
        `<tr>${t.columns
          .map((c) => {
            const unit = c.unit ?? (c.key !== "indicateur" && c.key !== "annee" ? rowUnit(r) : undefined);
            return `<td class="${c.align === "right" ? "r" : ""}">${esc(cellText(r[c.key], unit))}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("")}</tbody></table><div class="src">Sources : ${refs.map((n) => `[${n}]`).join(" ")}${t.note ? ` — ${esc(t.note)}` : ""}</div></figure>`;
}

function indicatorFor(r: Report, id: string, level = r.focus.level) {
  return r.indicators.find((i) => i.id === id && i.geo.level === level && (level !== "commune" || i.geo.code === r.commune.code || r.focus.level !== "commune"));
}

function kpisHtml(r: Report, ids: string[], cit: Citations) {
  const items = ids.map((id) => indicatorFor(r, id)).filter((i): i is Indicator => !!i && i.value != null);
  if (!items.length) return "";
  return `<div class="kpis">${items
    .map(
      (i) =>
        `<div class="kpi"><div class="kv">${esc(fmtValue(i.value, i.unit))}</div><div class="kl">${esc(i.label)}</div><div class="ks">${esc(i.year ?? "")} · [${cit.cite(i.source)}]${isSmallSample(i) || i.status === "partial" ? " · effectif faible" : ""}</div></div>`,
    )
    .join("")}</div>`;
}

function comparisonHtml(r: Report, ids: string[], title: string | undefined, cit: Citations) {
  const geos = r.references;
  const rows = ids
    .map((id) => {
      const vals = geos.map((g) => r.indicators.find((i) => i.id === id && i.geo.level === g.level && i.geo.code === g.code));
      const base = vals.find(Boolean);
      if (!base || !vals.some((v) => v?.value != null)) return null;
      return { base, vals };
    })
    .filter(Boolean) as { base: Indicator; vals: (Indicator | undefined)[] }[];
  if (!rows.length) return "";
  return `<figure class="tbl"><figcaption>${esc(title ?? "Comparaison")}</figcaption><table><thead><tr><th>Indicateur</th><th>Millésime</th>${geos.map((g) => `<th class="r">${esc(g.name)}<br><span class="lvl">${LEVEL_LABEL[g.level]}</span></th>`).join("")}</tr></thead><tbody>${rows
    .map(
      ({ base, vals }) =>
        `<tr><td>${esc(base.label)}</td><td>${esc(vals[0]?.year ?? base.year ?? "")}</td>${vals
          .map((v) => `<td class="r">${v?.value != null ? `${esc(fmtValue(v.value, v.unit))}<sup>${cit.cite(v.source)}</sup>` : "n.d."}</td>`)
          .join("")}</tr>`,
    )
    .join("")}</tbody></table><div class="src">n.d. : non disponible. Les numéros renvoient à la bibliographie des sources.</div></figure>`;
}

function findingsHtml(r: Report, b: Extract<Block, { type: "findings" }>, cit: Citations) {
  const fs = r.findings.filter((f) => (!b.kinds || b.kinds.includes(f.kind)) && (!b.themes || b.themes.includes(f.theme)));
  if (!fs.length) return b.title ? `<h4>${esc(b.title)}</h4><p class="muted">Aucun élément relevé automatiquement.</p>` : "";
  return `${b.title ? `<h4>${esc(b.title)}</h4>` : ""}<ul class="findings">${fs.map((f) => findingLi(r, f, cit)).join("")}</ul>`;
}

function findingLi(r: Report, f: Finding, cit: Citations) {
  const refs = [...new Set(f.evidence.map((e) => r.indicators.find((i) => `${i.id}@${i.geo.level}:${i.geo.code}` === e)).filter(Boolean).map((i) => cit.cite(i!.source)))];
  return `<li class="f-${f.kind}"><span class="tag">${esc(KIND_LABELS[f.kind])}</span> ${esc(f.text)}${refs.length ? ` <span class="refs">${refs.map((n) => `[${n}]`).join("")}</span>` : ""}</li>`;
}

function missingHtml(r: Report, themes: string[]) {
  const items = r.missing.filter((m) => !themes.length || themes.includes(m.theme));
  if (!items.length) return "";
  return `<div class="missing"><strong>Données manquantes ou non intégrées</strong><ul>${items.map((m) => `<li>${esc(m.label)} — <span class="muted">${esc(m.reason)}</span></li>`).join("")}</ul></div>`;
}

export function blockHtml(r: Report, b: Block, cit: Citations): string {
  switch (b.type) {
    case "paragraph": {
      const refs = [...new Set((b.evidence ?? []).map((e) => r.indicators.find((i) => `${i.id}@${i.geo.level}:${i.geo.code}` === e)).filter(Boolean).map((i) => cit.cite(i!.source)))];
      return `<p>${esc(b.text)}${refs.length ? ` <span class="refs">${refs.map((n) => `[${n}]`).join("")}</span>` : ""}</p>`;
    }
    case "kpis":
      return kpisHtml(r, b.indicatorIds, cit);
    case "comparison":
      return comparisonHtml(r, b.indicatorIds, b.title, cit);
    case "table": {
      const t = r.tables.find((x) => x.id === b.tableId);
      return t ? tableHtml(t, cit) : "";
    }
    case "chart": {
      const c = r.charts.find((x) => x.id === b.chartId);
      if (!c) return "";
      return `<figure class="chart"><figcaption>${esc(c.title)}</figcaption>${chartSvg(c)}<div class="src">Sources : ${c.sources.map((s) => `[${cit.cite(s)}]`).join(" ")}${c.note ? ` — ${esc(c.note)}` : ""}</div></figure>`;
    }
    case "map": {
      const m = r.maps.find((x) => x.id === b.mapId);
      if (!m) return "";
      const srcs = [...new Map(m.layers.map((l) => [l.source.id + l.source.url, l.source])).values()];
      return `<figure class="map"><figcaption>${esc(m.title)}</figcaption>${mapSvg(m)}<div class="src">Sources : ${srcs.map((s) => `[${cit.cite(s)}]`).join(" ")} · Fond : contours ADMIN EXPRESS (IGN) via geo.api.gouv.fr${m.note ? ` — ${esc(m.note)}` : ""}</div></figure>`;
    }
    case "locator": {
      if (!hasLocator(r.commune.departement.code)) return "";
      const s: SourceRef = { id: "svgmaps", name: SOURCES.svgmaps.name, url: SOURCES.svgmaps.homepage, retrievedAt: r.createdAt };
      return `<figure class="map locator"><figcaption>Localisation du département ${esc(r.commune.departement.nom)} en France métropolitaine</figcaption>${locatorSvg(r.commune.departement.code, r.commune.departement.nom)}<div class="src">Fond : [${cit.cite(s)}] (CC BY 4.0)</div></figure>`;
    }
    case "note":
      return `<div class="note">${esc(b.text)}</div>`;
    case "missing":
      return missingHtml(r, b.themes);
    case "findings":
      return findingsHtml(r, b, cit);
    case "list":
      return `${b.title ? `<h4>${esc(b.title)}</h4>` : ""}<ul class="list">${b.items.map((i) => `<li>${esc(i.text)}${i.url ? ` — <a href="${esc(i.url)}">${esc(i.url)}</a>` : ""}</li>`).join("")}</ul>`;
  }
}

export const REPORT_CSS = `
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }
* { box-sizing: border-box; }
body { font-family: "Public Sans", Inter, "DejaVu Sans", Arial, sans-serif; color: #0b0b0b; font-size: 10.5pt; line-height: 1.45; margin: 0; background: #fff; }
h1 { font-size: 26pt; margin: 0 0 6mm; color: #0d366b; }
h2 { font-size: 16pt; color: #0d366b; border-bottom: 2px solid #2a78d6; padding-bottom: 2mm; margin: 0 0 4mm; break-after: avoid; }
h3 { font-size: 12pt; margin: 6mm 0 2mm; }
h4 { font-size: 11pt; margin: 5mm 0 2mm; color: #1c5cab; break-after: avoid; }
p { margin: 0 0 3mm; text-align: justify; }
a { color: #1c5cab; word-break: break-all; }
section.part { break-before: page; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: space-between; }
.cover .kicker { font-size: 11pt; letter-spacing: .08em; text-transform: uppercase; color: #52514e; }
.cover .sub { font-size: 13pt; color: #52514e; }
.cover .meta { font-size: 9.5pt; color: #52514e; border-top: 1px solid #e7e6e2; padding-top: 4mm; }
.cover .warn, .warn { background: #fff7e6; border-left: 4px solid #eda100; padding: 3mm 4mm; margin: 3mm 0; font-size: 9.5pt; }
.toc ol { padding-left: 5mm; } .toc li { margin: 1.5mm 0; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 4mm 0; break-inside: avoid; }
.kpi { border: 1px solid #e7e6e2; border-radius: 3mm; padding: 3mm; }
.kv { font-size: 15pt; font-weight: 700; color: #0d366b; }
.kl { font-size: 8.5pt; color: #0b0b0b; margin-top: 1mm; }
.ks { font-size: 7.5pt; color: #8a8984; margin-top: 1mm; }
figure { margin: 4mm 0 5mm; break-inside: avoid; }
figcaption { font-weight: 600; font-size: 10pt; margin-bottom: 2mm; color: #0b0b0b; }
figure svg { max-width: 100%; height: auto; display: block; }
figure.locator svg { max-width: 70mm; }
table { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
th { text-align: left; background: #f3f6fb; color: #0b0b0b; font-weight: 600; padding: 1.6mm 2mm; border-bottom: 1px solid #b7d3f6; vertical-align: bottom; }
td { padding: 1.3mm 2mm; border-bottom: 1px solid #eeeeec; vertical-align: top; }
tr { break-inside: avoid; }
.r { text-align: right; font-variant-numeric: tabular-nums; }
.lvl { font-weight: 400; color: #8a8984; font-size: 7.5pt; }
sup { color: #8a8984; font-size: 6.5pt; margin-left: .5mm; }
.src { font-size: 7.8pt; color: #52514e; margin-top: 1.5mm; }
.refs { font-size: 7.8pt; color: #8a8984; }
.note { font-size: 9pt; color: #52514e; background: #f6f6f4; padding: 3mm 4mm; border-radius: 2mm; margin: 3mm 0; }
.missing { font-size: 8.8pt; border: 1px dashed #c3c2b7; padding: 2.5mm 4mm; border-radius: 2mm; margin: 4mm 0; break-inside: avoid; }
.missing ul { margin: 1mm 0 0; padding-left: 5mm; }
.muted { color: #8a8984; }
ul.findings { list-style: none; padding: 0; margin: 0 0 3mm; }
ul.findings li { padding: 1.6mm 0 1.6mm 0; border-bottom: 1px solid #f0efec; break-inside: avoid; }
.tag { display: inline-block; font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: .4mm 1.6mm; border-radius: 1.5mm; margin-right: 1mm; background: #eef2f7; color: #1c5cab; }
.f-atout .tag { background: #e3f5ec; color: #0b6b47; }
.f-vigilance .tag { background: #fdecea; color: #a12a29; }
.f-hypothese .tag { background: #f1eefc; color: #4a3aa7; }
.f-piste .tag { background: #fff3e0; color: #8a5300; }
.f-a_verifier .tag { background: #f3f3f1; color: #52514e; }
ul.list li { margin: 1mm 0; }
.biblio li { margin: 1.2mm 0; font-size: 8.8pt; }
.runs td { font-size: 8pt; }
.ok { color: #0b6b47; } .ko { color: #a12a29; } .wa { color: #8a5300; }
`;

export function renderReportHtml(r: Report, opts: { standalone?: boolean } = {}): string {
  const cit = new Citations();
  // Le corps est rendu en premier pour numéroter les sources dans l'ordre d'apparition.
  const body = r.sections
    .map((s) => `<section class="part" id="part-${s.id}"><h2>${s.letter}. ${esc(s.title)}</h2>${s.blocks.map((b) => blockHtml(r, b, cit)).join("\n")}</section>`)
    .join("\n");
  const statusClass = (s: string) => (s === "ok" || s === "cache" ? "ok" : s === "failed" ? "ko" : "wa");
  const STATUS_FR: Record<string, string> = { ok: "Réussi", cache: "Cache", stale: "Cache périmé", partial: "Partiel", failed: "Échec", skipped: "Non exécuté" };
  const sourcesUsed = [...new Set(r.runs.map((x) => x.sourceId))];
  const method = `<section class="part" id="methodo"><h2>Méthodologie, sources et limites</h2>
<h3>Principes</h3>
<p>Cette fiche est générée automatiquement à partir de données publiques. Les calculs (ratios, écarts, évolutions, détection de valeurs atypiques) sont réalisés par un code déterministe et testé ; aucune valeur n'est estimée ou imputée lorsqu'une donnée manque : elle est signalée « n.d. ». Les textes sont produits par des gabarits à partir des seules valeurs observées (moteur de rédaction : ${esc(r.narrativeEngine)}).</p>
<p><strong>Règle de significativité des écarts</strong> : pour un taux, un écart à la référence est jugé significatif s'il atteint au moins 2 points et 10 % en valeur relative ; pour les autres grandeurs, 10 % en valeur relative. <strong>Valeurs atypiques</strong> : score z robuste (écart à la médiane rapporté à 1,4826 × l'écart absolu médian) d'au moins 2 en valeur absolue parmi les communes comparables (au moins 5 communes disposant de la donnée). <strong>Petits effectifs</strong> : un ratio calculé sur moins de 200 unités ou un prix médian calculé sur moins de 30 ventes est signalé.</p>
<p><strong>Typologie des énoncés</strong> : les <em>constats</em> décrivent des valeurs observées ; les <em>atouts</em> et <em>points de vigilance</em> qualifient un écart significatif dans un sens favorable ou défavorable ; les <em>hypothèses</em> proposent des pistes d'explication à vérifier ; les <em>pistes d'action</em> portent sur des enjeux territoriaux objectifs ; les éléments <em>à vérifier</em> signalent des données manquantes ou fragiles.</p>
<h3>Journal de collecte</h3>
<table class="runs"><thead><tr><th>Source</th><th>Étape</th><th>Statut</th><th class="r">Requêtes</th><th class="r">dont cache</th><th>Date</th><th>Message</th></tr></thead><tbody>${r.runs
    .map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.step)}</td><td class="${statusClass(x.status)}">${STATUS_FR[x.status]}</td><td class="r">${x.requests}</td><td class="r">${x.fromCache}</td><td>${esc(fmtDate(x.retrievedAt))}</td><td>${esc(x.message ?? "")}</td></tr>`)
    .join("")}</tbody></table>
<h3>Bibliographie des sources citées</h3>
<ol class="biblio">${cit
    .all()
    .map((s) => `<li>${esc(sourceLabel(s))}. ${SOURCES[s.id] ? `${esc(SOURCES[s.id].producer)}. Licence : ${esc(SOURCES[s.id].license)}. ` : ""}Consulté le ${esc(fmtDate(s.retrievedAt))}. <a href="${esc(s.url)}">${esc(s.url.length > 160 ? s.url.slice(0, 157) + "…" : s.url)}</a></li>`)
    .join("")}</ol>
<h3>Catalogue des sources interrogées : licences et limites</h3>
<ul class="biblio">${sourcesUsed
    .filter((id) => SOURCES[id])
    .map((id) => `<li><strong>${esc(SOURCES[id].name)}</strong> (${esc(SOURCES[id].producer)}) — ${esc(SOURCES[id].access)} Licence : ${esc(SOURCES[id].license)}. Limites : ${esc(SOURCES[id].limits)}</li>`)
    .join("")}</ul>
</section>`;

  const scopeLabel = { commune: "Commune", epci: "Intercommunalité", departement: "Département", custom: "Territoire personnalisé" }[r.query.scope];
  const cover = `<section class="cover"><div><div class="kicker">Diagnostic territorial</div><h1>${esc(r.commune.nom)}</h1><div class="sub">${esc(r.commune.departement.nom)} (${esc(r.commune.departement.code)}) · ${esc(r.commune.region.nom)}${r.commune.epci ? ` · ${esc(r.commune.epci.nom)}` : ""}</div><p class="sub" style="margin-top:4mm">Périmètre d'analyse : ${esc(scopeLabel)} — ${esc(r.perimeter.label)}</p>
${r.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}
<div class="warn" style="border-color:#2a78d6;background:#eef5fd">Ce document est produit automatiquement à partir de statistiques publiques agrégées. Ses constats doivent être confrontés à la connaissance de terrain des acteurs locaux.</div></div>
<div class="toc"><h3>Sommaire</h3><ol type="A">${r.sections.map((s) => `<li>${esc(s.title)}</li>`).join("")}</ol><p>Annexe : méthodologie, journal de collecte et bibliographie.</p></div>
<div class="meta">Code INSEE ${esc(r.commune.code)} · Généré le ${esc(fmtDate(r.updatedAt))} (version ${r.version}) · Identifiant ${esc(r.id)}<br>Fraîcheur des données : ${esc(freshness(r))}</div></section>`;

  const html = `${cover}\n${body}\n${method}`;
  if (opts.standalone === false) return html;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Diagnostic territorial — ${esc(r.commune.nom)}</title><style>${REPORT_CSS}</style></head><body>${html}</body></html>`;
}

/** Résumé de fraîcheur : millésimes extrêmes et date de collecte la plus ancienne. */
export function freshness(r: Report) {
  const vint = r.indicators.map((i) => i.year).filter((y): y is string => !!y).map((y) => y.slice(-4)).filter((y) => /^\d{4}$/.test(y)).sort();
  const dates = r.runs.filter((x) => x.status !== "failed" && x.status !== "skipped").map((x) => x.retrievedAt).sort();
  const parts = [];
  if (vint.length) parts.push(`millésimes statistiques de ${vint[0]} à ${vint[vint.length - 1]}`);
  if (dates.length) parts.push(`données collectées entre le ${fmtDate(dates[0])} et le ${fmtDate(dates[dates.length - 1])}`);
  return parts.join(" ; ") || "non déterminée";
}

export { THEME_LABELS };
