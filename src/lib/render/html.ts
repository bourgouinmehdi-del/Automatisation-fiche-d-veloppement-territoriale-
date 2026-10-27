import { ICONS } from "./icons";
import { niveauAcces } from "./indice";
import { splitWarnings } from "../report/warnings";
import { presenceRef, presenceScale, presenceValue } from "./presence";
import { posterItems } from "./poster";
import { SOURCES } from "../collectors/catalog";
import { KIND_LABELS, THEME_LABELS } from "../analysis/findings";
import { isSmallSample } from "../analysis/stats";
import { docTitle, fmtDate, fmtNumber, fmtValue, isTerritorial, scoreColor, territoryName } from "../format";
import { FIELD_NOTE_LABELS } from "../types";
import type { Block, DataTable, Finding, Indicator, MapSpec, Report, SourceRef } from "../types";
import { chartSvg, hasLocator, locatorSvg, mapSvg } from "./svg";
import { cellText, Citations, inlineParts, sourceLabel } from "./cite";

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

/** Texte échappé, avec `**gras**` et retours à la ligne. */
export const inline = (s: unknown) =>
  inlineParts(String(s ?? ""))
    .map((p) => (p.bold ? `<strong>${esc(p.text)}</strong>` : esc(p.text)))
    .join("")
    .replace(/\n/g, "<br>");

const LEVEL_LABEL: Record<string, string> = { commune: "Commune", epci: "Intercommunalité", departement: "Département", region: "Région", france: "France", bureau_vote: "Bureau de vote" };

function tableHtml(t: DataTable, cit: Citations) {
  const refs = t.sources.map((s) => cit.cite(s));
  const rowUnit = (r: Record<string, string | number | null>) => (r.unite as string | undefined) ?? undefined;
  return `<figure class="tbl"><figcaption>${esc(t.title)}</figcaption><table><thead><tr>${t.columns.map((c) => `<th class="${c.align === "right" ? "r" : ""}${c.wide ? " w" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${t.rows
    .map(
      (r, i) =>
        `<tr${t.highlight?.includes(i) ? ' class="hl"' : ""}>${t.columns
          .map((c) => {
            const unit = c.unit ?? (c.key !== "indicateur" && c.key !== "annee" ? rowUnit(r) : undefined);
            if (c.bar && typeof r[c.key] === "number") {
              const v = r[c.key] as number;
              return `<td class="sb"><span class="sbar"><span style="width:${Math.max(2, Math.min(100, v))}%;background:${scoreColor(v)}"></span></span><b>${v}</b></td>`;
            }
            return `<td class="${c.align === "right" ? "r" : ""}">${inline(cellText(r[c.key], unit))}</td>`;
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
        `<div class="kpi"><div class="kv">${esc(fmtValue(i.value, i.unit))}</div><div class="kl">${esc(i.label)}${i.geo.level !== "commune" ? ` — ${esc(i.geo.name)}` : ""}</div><div class="ks">${esc(i.year ?? "")} · [${cit.cite(i.source)}]${isSmallSample(i) || i.status === "partial" ? " · effectif faible" : ""}</div></div>`,
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

/** Liste « Où agir » d'une carte affiche, en HTML (coupée proprement entre les pages, contrairement à l'image). */
function posterListHtml(m: MapSpec): string {
  const items = posterItems(m);
  if (!items.length) return "";
  const groups: { action: string; group: string; items: typeof items }[] = [];
  for (const it of items) {
    const g = groups.find((x) => x.group === it.group);
    if (g) g.items.push(it);
    else groups.push({ action: it.action, group: it.group, items: [it] });
  }
  const badge = (it: (typeof items)[number]) => `<span class="oa-b oa-${it.shape}" style="background:${it.color}">${it.n}</span>`;
  return `<section class="oa"><h4 class="oa-t">Où agir</h4>${groups
    .map(
      (g) =>
        `<div class="oa-g"><div class="oa-gt">${esc(g.action !== g.group ? `${g.action} — ${g.group}` : g.group)}</div><ol>${g.items
          .map((it) => `<li>${badge(it)}<div><b>${esc(it.nom)}</b>${(it.det.length ? it.det : [it.sub]).filter(Boolean).map((d) => `<div>${esc(d)}</div>`).join("")}${it.quand ? `<div class="oa-q">Quand : ${esc(it.quand)}</div>` : ""}</div></li>`)
          .join("")}</ol></div>`,
    )
    .join("")}</section>`;
}

/** Noms longs (« Saint-Jacques-de-la-Lande ») : titre plus petit, sans coupure au milieu d'un mot. */
const titleClass = (t: string) => (t.length > 26 ? ' class="xlong"' : t.length > 16 ? ' class="long"' : "");

export function selectFindings(r: Report, b: Extract<Block, { type: "findings" }>) {
  if (b.ids) return b.ids.map((id) => r.findings.find((f) => f.id === id)).filter((f): f is Finding => !!f);
  return r.findings.filter((f) => (!b.kinds || b.kinds.includes(f.kind)) && (!b.themes || b.themes.includes(f.theme)));
}

const refsHtml = (refs: number[]) => (refs.length ? ` <span class="refs">${refs.map((n) => `[${n}]`).join("")}</span>` : "");

function findingRefs(r: Report, f: { evidence?: string[] }, cit: Citations) {
  return [...new Set((f.evidence ?? []).map((e) => r.indicators.find((i) => `${i.id}@${i.geo.level}:${i.geo.code}` === e)).filter(Boolean).map((i) => cit.cite(i!.source)))];
}

function findingsHtml(r: Report, b: Extract<Block, { type: "findings" }>, cit: Citations) {
  const fs = selectFindings(r, b);
  if (!fs.length) return b.title ? `<h4>${esc(b.title)}</h4><p class="muted">Aucun élément relevé automatiquement.</p>` : "";
  if (b.style === "prose")
    return `${b.title ? `<h4>${esc(b.title)}</h4>` : ""}${fs
      .map((f) => `<p class="prose${f.kind === "hypothese" ? " hyp" : ""}">${f.kind === "hypothese" ? '<span class="hyp-l">Hypothèse</span> ' : ""}${inline(f.text)}${refsHtml(findingRefs(r, f, cit))}</p>`)
      .join("")}`;
  return `${b.title ? `<h4>${esc(b.title)}</h4>` : ""}<ul class="findings">${fs.map((f) => findingLi(r, f, cit)).join("")}</ul>`;
}

function findingLi(r: Report, f: Finding, cit: Citations) {
  return `<li class="f-${f.kind}"><span class="tag">${esc(KIND_LABELS[f.kind])}</span> ${inline(f.text)}${refsHtml(findingRefs(r, f, cit))}</li>`;
}

function missingHtml(r: Report, themes: string[]) {
  const items = r.missing.filter((m) => !themes.length || themes.includes(m.theme));
  if (!items.length) return "";
  return `<div class="missing"><strong>Données manquantes ou non intégrées</strong><ul>${items.map((m) => `<li>${esc(m.label)} — <span class="muted">${esc(m.reason)}</span></li>`).join("")}</ul></div>`;
}

export type FicheStyle = "moderne" | "yonne";

/**
 * Blocs d'une partie : un titre suivi d'un court texte et d'une carte reste avec la carte (pas de titre
 * seul en bas de page, la carte en haut de la suivante).
 */
export function blocksHtml(r: Report, blocks: Block[], cit: Citations, style: FicheStyle = "moderne"): string {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const lead = b.type === "heading" || (b.type === "paragraph" && b.text.length < 300);
    if (lead) {
      let j = i + 1;
      while (j < blocks.length && j - i < 3 && blocks[j].type === "paragraph" && (blocks[j] as { text: string }).text.length < 300) j++;
      if (j < blocks.length && blocks[j].type === "map") {
        out.push(`<div class="keep">${blocks.slice(i, j + 1).map((x) => blockHtml(r, x, cit, style)).join("\n")}</div>`);
        i = j;
        continue;
      }
    }
    out.push(blockHtml(r, b, cit, style));
  }
  return out.join("\n");
}

export function blockHtml(r: Report, b: Block, cit: Citations, style: FicheStyle = "moderne"): string {
  switch (b.type) {
    case "paragraph": {
      const refs = [...new Set((b.evidence ?? []).map((e) => r.indicators.find((i) => `${i.id}@${i.geo.level}:${i.geo.code}` === e)).filter(Boolean).map((i) => cit.cite(i!.source)))];
      return `<p>${inline(b.text)}${refsHtml(refs)}</p>`;
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
      return `<figure class="chart"><figcaption>${esc(c.title)}</figcaption>${chartSvg(c)}<div class="src">Sources : ${[...new Set(c.sources.map((s) => `[${cit.cite(s)}]`))].join(" ")}${c.note ? ` — ${esc(c.note)}` : ""}</div></figure>`;
    }
    case "map": {
      const m = r.maps.find((x) => x.id === b.mapId);
      if (!m) return "";
      const srcs = [...new Map(m.layers.map((l) => [l.source.id + l.source.url, l.source])).values()];
      // Carte « affiche » : titre, légende et source sont dans l'image ; renvois aux sources en dessous.
      if (m.poster) return `<figure class="map poster">${mapSvg(m, 720, 540, { posterList: false })}</figure>${posterListHtml(m)}<div class="src">Sources : ${[...new Set(srcs.map((s) => `[${cit.cite(s)}]`))].join(" ")}${m.note ? ` — ${esc(m.note)}` : ""}</div>`;
      return `<figure class="map"><figcaption>${esc(m.title)}</figcaption>${mapSvg(m)}<div class="src">Sources : ${[...new Set(srcs.map((s) => `[${cit.cite(s)}]`))].join(" ")} · Fond : contours ADMIN EXPRESS (IGN) via geo.api.gouv.fr${m.note ? ` — ${esc(m.note)}` : ""}</div></figure>`;
    }
    case "locator": {
      if (!hasLocator(r.commune.departement.code)) return "";
      const s: SourceRef = { id: "svgmaps", name: SOURCES.svgmaps.name, url: SOURCES.svgmaps.homepage, retrievedAt: r.createdAt };
      return `<figure class="map locator"><figcaption>Localisation du département ${esc(r.commune.departement.nom)} en France métropolitaine</figcaption>${locatorSvg(r.commune.departement.code, r.commune.departement.nom)}<div class="src">Fond : [${cit.cite(s)}] (CC BY 4.0)</div></figure>`;
    }
    case "mapPair": {
      const ms = b.mapIds.map((id) => r.maps.find((x) => x.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
      if (!ms.length) return "";
      const srcs = [...new Map(ms.flatMap((m) => m.layers.map((l) => [l.source.id + l.source.url, l.source] as const))).values()];
      return `<figure class="map pair"><figcaption>${esc(b.title ?? ms.map((m) => m.title).join(" / "))}</figcaption><div class="pair-grid">${ms
        .map((m) => `<div><div class="pair-t">${esc(m.period ?? m.title)}</div>${mapSvg(m, 420, 470)}</div>`)
        .join("")}</div><div class="src">Sources : ${[...new Set(srcs.map((s) => `[${cit.cite(s)}]`))].join(" ")}${ms[0].note ? ` — ${esc(ms[0].note)}` : ""}</div></figure>`;
    }
    case "note":
      return `<div class="note">${inline(b.text)}</div>`;
    case "callout":
      return `<div class="callout ${b.tone ?? "info"}">${b.title ? `<div class="callout-t">${esc(b.title)}</div>` : ""}${inline(b.text)}</div>`;
    case "heading":
      return `<h3 class="fh">${esc(b.text)}</h3>`;
    case "targets":
      return b.items
        .map((t, k) => {
          const tb = r.tables.find((x) => x.id === t.tableId);
          return `<section class="target" style="--tc:${esc(t.color)}"><div class="target-k"><span class="dot" style="background:${esc(t.color)}"></span>Proposition de ciblage n°${k + 1}</div><h3 class="target-t">${esc(t.nom)}</h3>${t.focus?.length ? `<div class="target-f">Focus possibles : ${esc(t.focus.join(", "))}</div>` : ""}<ul class="list">${t.raisons.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>${tb ? tableHtml(tb, cit) : ""}</section>`;
        })
        .join("");
    case "fieldNotes": {
      const n = b.part ? r.fieldNotes?.parts?.[b.part] : r.fieldNotes;
      const title = FIELD_NOTE_LABELS[b.part ?? "general"].title;
      return n?.text.trim()
        ? `<div class="callout terrain"><div class="callout-t">${esc(title)} <span class="muted" style="font-weight:400">(mis à jour le ${esc(fmtDate(n.updatedAt))})</span></div>${inline(n.text.trim())}</div>`
        : "";
    }
    case "fieldPlaces": {
      const items = r.fieldPlaces?.items ?? [];
      if (!items.length) return "";
      const rows = [...items].sort((a, b) => Number(!!b.prioritaire) - Number(!!a.prioritaire) || a.type.localeCompare(b.type));
      return `<figure class="tbl"><figcaption>Lieux d'action signalés par les militants <span class="muted" style="font-weight:400">(mis à jour le ${esc(fmtDate(r.fieldPlaces!.updatedAt))})</span></figcaption><table><thead><tr><th>Type</th><th>Lieu</th><th>Jours et horaires</th><th>Adresse</th><th>Bureau</th></tr></thead><tbody>${rows
        .map((p) => `<tr${p.prioritaire ? ' class="hl"' : ""}><td>${esc(p.type)}</td><td>${esc(p.nom)}</td><td>${esc(p.horaires)}</td><td>${esc(p.adresse)}</td><td>${p.bv ? `BV ${esc(p.bv)}${p.prioritaire ? " (prioritaire)" : ""}` : ""}</td></tr>`)
        .join("")}</tbody></table></figure>`;
    }
    case "glance":
      if (style === "yonne")
        return `<ul class="yl">${b.items.map((i) => `<li>${esc(i.label)} : <strong>${esc(i.value)}</strong>${i.detail ? ` (${esc(i.detail)})` : ""}</li>`).join("")}</ul>`;
      return `<div class="glance">${b.items
        .map((i) => `<div class="gl ${i.tone ?? "neutral"}"><div class="gl-v">${esc(i.value)}</div><div class="gl-l">${esc(i.label)}</div>${i.detail ? `<div class="gl-d">${esc(i.detail)}</div>` : ""}</div>`)
        .join("")}</div>`;
    case "services": {
      const niv: Record<string, string> = { mieux: "Mieux desservie", comme: "Dans la moyenne", moins: "Moins bien desservie" };
      const faibles = b.faibles.length
        ? `<div class="sv-sub">Points faibles</div><ul class="sv-l">${b.faibles.map((f) => `<li><span class="sv-i">${ICONS[f.cat] ?? ""}</span><b>${esc(f.label)}</b> : ${esc(f.txt)}</li>`).join("")}</ul>`
        : "";
      const dessous = b.enDessous?.length
        ? `<div class="sv-sub">${b.faibles.length ? "Un peu en dessous de la moyenne" : "Pas de service très en retard, mais plusieurs un peu en dessous de la moyenne"}</div><ul class="sv-l">${b.enDessous.map((f) => `<li><span class="sv-i">${ICONS[f.cat] ?? ""}</span><b>${esc(f.label)}</b> : ${esc(f.txt)}</li>`).join("")}</ul>`
        : "";
      const cats = `<div class="sv-sub">Détail par thème</div><table class="sv-t"><tbody>${b.cats.map((c) => `<tr><td><span class="sv-i">${ICONS[c.cat] ?? ""}</span><b>${esc(c.label)}</b></td><td class="sv-${c.niveau}">${niv[c.niveau]}</td><td class="sv-d">${c.details.map((d) => `${esc(d.label)} : ${esc(d.txt)}`).join(" ; ")}</td></tr>`).join("")}</tbody></table>`;
      const pas = (v: number, big = false) => {
        const n = niveauAcces(v);
        return `<span class="sv-p${big ? " big" : ""}" style="background:${n.bg};color:${n.fg}">${n.txt}</span>`;
      };
      const indice = b.indice
        ? `<div class="sv-ix"><div>Accès aux services, comparé ${b.indice.ref === "France" ? "à l'habitant moyen en France" : "à l'habitant moyen du département"} : ${pas(b.indice.global, true)}</div><table class="sv-g"><tbody>${b.indice.gammes.map((g) => `<tr><td class="sv-gl"><b>${g.cat ? `<span class="sv-i">${ICONS[g.cat] ?? ""}</span>` : ""}${esc(g.label)}</b></td><td class="sv-gp">${pas(g.value)}</td><td class="sv-d">${esc(g.exemples ?? "")}</td></tr>`).join("")}</tbody></table></div>`
        : "";
      return `<figure class="services"><figcaption>${esc(b.title)}</figcaption>${indice}${faibles}${dessous}${cats}<div class="pr-n">${esc(b.note)}</div></figure>`;
    }
    case "plan":
      return `<div class="plan">${b.items
        .map((it) => `<div class="pl-i"><div class="pl-h"><b>${esc(it.label)}</b><span>${esc(it.count)}</span></div>${it.quand ? `<div class="pl-q">${esc(it.quand)}</div>` : ""}<ul>${it.details.slice(0, 8).map((d) => `<li>${esc(d)}</li>`).join("")}${it.details.length > 8 ? `<li>… et ${it.details.length - 8} autres</li>` : ""}</ul></div>`)
        .join("")}</div>`;
    case "presence":
      return `<figure class="presence"><figcaption>${esc(b.title)}</figcaption>${b.rows
        .map((row) => {
          const s = presenceScale(row);
          return `<div class="pr-row"><div class="pr-l"><b>${esc(row.label)}</b>${row.sub ? `<span>${esc(row.sub)}</span>` : ""}</div><div class="pr-bar"><i style="width:${(100 * s.fill).toFixed(1)}%"></i><em style="left:${(100 * s.tick).toFixed(1)}%"></em></div><div class="pr-v"><b>${esc(presenceValue(row, "nombre"))}</b><span>${esc(presenceValue(row, "ratio"))} ${esc(row.rUnit)}</span><span>${esc(presenceRef(row, "ratio"))}</span></div></div>`;
        })
        .join("")}${b.note ? `<div class="pr-n">${esc(b.note)}</div>` : ""}</figure>`;
    case "actions":
      return `${b.title ? `<h4>${esc(b.title)}</h4>` : ""}<div class="actions">${b.groups
        .map((g) => `<div class="ag"><div class="ag-t">${esc(g.title)}${g.hint ? ` <span class="ag-h">(${esc(g.hint)})</span>` : ""} :</div><ul>${g.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul></div>`)
        .join("")}</div>`;
    case "missing":
      return missingHtml(r, b.themes);
    case "findings":
      return findingsHtml(r, b, cit);
    case "list":
      return `${b.title ? `<h4>${esc(b.title)}</h4>` : ""}<ul class="list">${b.items.map((i) => `<li>${inline(i.text)}${refsHtml(findingRefs(r, i, cit))}${i.url ? ` — <a href="${esc(i.url)}">${esc(i.url)}</a>` : ""}</li>`).join("")}</ul>`;
  }
}

export const REPORT_CSS = `
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }
* { box-sizing: border-box; }
body { font-family: "Stack Sans Text Variable", "Stack Sans Text", "DejaVu Sans", Arial, sans-serif; color: #212320; font-size: 10.5pt; line-height: 1.45; margin: 0; background: #fff; }
h1, h2, h3.fh, h3.target-t, .kv, .gl-v { font-family: "Union Gothic Condensed", "Union Gothic", "Archivo Variable", "Archivo", "Arial Narrow", sans-serif; font-stretch: 62%; }
h1 { font-size: 30pt; font-weight: 900; margin: 0 0 6mm; color: #4c0297; }
h2 { font-size: 18pt; font-weight: 800; color: #4c0297; border-bottom: 2px solid #4c0297; padding-bottom: 2mm; margin: 0 0 4mm; break-after: avoid; }
h3 { font-size: 12pt; margin: 6mm 0 2mm; }
h4 { font-size: 11pt; margin: 5mm 0 2mm; color: #4c0297; break-after: avoid; }
p { margin: 0 0 3mm; text-align: justify; }
a { color: #4c0297; word-break: break-all; }
section.part { break-before: page; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: space-between; }
.cover .kicker { font-size: 12pt; font-weight: 700; color: #d1271c; }
.cover .sub { font-size: 13pt; color: #52514e; }
.cover .meta { font-size: 9.5pt; color: #52514e; border-top: 1px solid #e7e6e2; padding-top: 4mm; }
.cover .warn, .warn { background: #fdecea; border-left: 4px solid #d1271c; padding: 3mm 4mm; margin: 3mm 0; font-size: 9.5pt; }
.toc ol { padding-left: 5mm; } .toc li { margin: 1.5mm 0; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 4mm 0; break-inside: avoid; }
.kpi { border: 1px solid #e7e6e2; border-radius: 3mm; padding: 3mm; }
.kv { font-size: 18pt; font-weight: 900; color: #4c0297; }
.kl { font-size: 8.5pt; color: #0b0b0b; margin-top: 1mm; }
.ks { font-size: 7.5pt; color: #8a8984; margin-top: 1mm; }
figure { margin: 4mm 0 5mm; break-inside: avoid; }
figcaption { font-weight: 600; font-size: 10pt; margin-bottom: 2mm; color: #0b0b0b; }
figure svg { max-width: 100%; height: auto; display: block; }
figure.locator svg { max-width: 70mm; }
table { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
th { text-align: left; background: #ede5ff; color: #1d003c; font-weight: 700; padding: 1.6mm 2mm; border-bottom: 1.5px solid #4c0297; vertical-align: bottom; }
td { padding: 1.3mm 2mm; border-bottom: 1px solid #eeeeec; vertical-align: top; }
tr { break-inside: avoid; }
.r { text-align: right; font-variant-numeric: tabular-nums; }
td.r { white-space: nowrap; }
th.w { min-width: 30mm; }
figure.tbl { break-inside: auto; }
figure.tbl figcaption { break-after: avoid; }
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
.tag { display: inline-block; font-size: 7.5pt; font-weight: 700; padding: .4mm 1.6mm; border-radius: 1.5mm; margin-right: 1mm; background: #ede5ff; color: #4c0297; }
.f-atout .tag { background: #e3f5ec; color: #0b6b47; }
.f-vigilance .tag { background: #fdecea; color: #a12a29; }
.f-hypothese .tag { background: #ede5ff; color: #4c0297; }
.f-piste .tag { background: #fff3e0; color: #8a5300; }
.f-a_verifier .tag { background: #f3f3f1; color: #52514e; }
ul.list li { margin: 1mm 0; }
.biblio li { margin: 1.2mm 0; font-size: 8.8pt; }
.runs td { font-size: 8pt; }
.ok { color: #0b6b47; } .ko { color: #a12a29; } .wa { color: #8a5300; }
strong { font-weight: 700; }
tr.hl td { font-weight: 700; background: #fdecea; }
tr.hl td strong { font-weight: 800; }
/* ---- Fiche d'action (modèle « Développement territorial ») ---- */
.fiche-head { background: #4c0297; color: #fff; padding: 5mm 6mm 9mm; margin-bottom: 6mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.fiche-k { font-size: 9.5pt; color: #c9adff; font-weight: 600; }
.fiche-pc { font-size: 11pt; font-weight: 700; margin-top: 3mm; color: #fff; }
.fiche-head h1 { font-size: 34pt; color: #fff; margin: 4mm 0 2mm; text-transform: uppercase; transform: skewY(-6deg); transform-origin: 0 100%; word-break: normal; overflow-wrap: normal; hyphens: manual; line-height: 1.05; }
.fiche-head h1.long { font-size: 26pt; }
.fiche-head h1.xlong { font-size: 21pt; }
.fiche-sub { font-size: 10.5pt; color: #fff; }
.fiche-meta { font-size: 8.5pt; color: #c9adff; margin-top: 1mm; }
h3.fh { font-size: 15pt; font-weight: 800; color: #4c0297; margin: 7mm 0 3mm; padding-bottom: 1mm; border-bottom: 1.5px solid #4c0297; break-after: avoid; }
.callout { border: 1px solid #4c0297; border-radius: 2mm; padding: 3mm 4mm; margin: 3mm 0 4mm; font-size: 9.8pt; break-inside: avoid; text-align: left; }
.callout.warning { border-width: 1.5px; background: #fff; }
.callout.accent { border-color: #c9adff; background: #f7f2ff; }
.callout.info { border-color: #e9e3d3; background: #fffcf4; }
.callout-t { font-weight: 700; margin-bottom: 1mm; }
.callout.terrain { border-color: #1baf7a; background: #f1faf6; }
.glance { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2.5mm; margin: 4mm 0 3mm; break-inside: avoid; }
.gl { border: 0; border-left: 1mm solid #e9e3d3; padding: .5mm 0 .5mm 3mm; }
.gl.up { border-left-color: #d1271c; } .gl.up .gl-v { color: #d1271c; } .gl.down { border-left-color: #85877f; }
.sv-ix { font-size: 9.5pt; margin: 1mm 0 3mm; border: 1px solid #e7e6e2; border-radius: 1.5mm; padding: 2mm 3mm; }
.sv-g { margin-top: 2mm; font-size: 8.6pt; border-collapse: collapse; }
.sv-g td { padding: 0.8mm 2mm 0.8mm 0; vertical-align: middle; border: 0; }
.sv-gl { white-space: nowrap; } .sv-gp { white-space: nowrap; }
.sv-p { display: inline-block; border-radius: 99px; padding: 0.4mm 2.2mm; font-weight: 700; font-size: 8.2pt; white-space: nowrap; }
.sv-p.big { font-size: 9.5pt; padding: 0.8mm 3mm; }
.services { border: 1px solid #e7e6e2; border-radius: 2mm; padding: 3mm 4mm; }
.sv-sub { font-weight: 700; font-size: 9pt; margin: 1.5mm 0 1mm; color: #4c0297; }
.sv-l { margin: 0 0 2mm; padding: 0; list-style: none; font-size: 9pt; } .sv-l li { margin: .8mm 0; }
.sv-i { display: inline-block; vertical-align: -3px; margin-right: 1.5mm; color: #4c0297; } .sv-i svg { width: 13px; height: 13px; }
.sv-t { font-size: 8.6pt; } .sv-t td { padding: 1mm 1.5mm; border-bottom: 1px solid #eeeeec; vertical-align: top; }
.sv-moins { color: #d1271c; font-weight: 700; white-space: nowrap; } .sv-mieux { color: #1b7f55; white-space: nowrap; } .sv-comme { color: #52514e; white-space: nowrap; } .sv-d { color: #52514e; }
.plan { margin: 3mm 0; break-inside: auto; }
.keep { break-inside: avoid; }
.pl-i { border-top: 1px solid #e7e6e2; padding: 1.5mm 0; break-inside: avoid; }
.pl-h { display: flex; justify-content: space-between; gap: 4mm; } .pl-h span { color: #4c0297; font-weight: 700; font-size: 9.5pt; white-space: nowrap; }
.pl-q { color: #52514e; font-size: 8.4pt; }
.pl-i ul { margin: 1mm 0 0 5mm; padding: 0; font-size: 8.8pt; }
.presence { border: 1px solid #e7e6e2; border-radius: 2mm; padding: 3mm 4mm; }
.pr-row { display: grid; grid-template-columns: 46mm 1fr 46mm; gap: 3mm; align-items: center; margin: 1.5mm 0; }
.pr-l b { display: block; font-size: 9.5pt; } .pr-l span, .pr-v span, .pr-n { display: block; font-size: 7.6pt; color: #52514e; }
.pr-bar { position: relative; height: 3.2mm; background: #ede5ff; border-radius: 1mm; }
.pr-bar i { position: absolute; left: 0; top: 0; bottom: 0; background: #4c0297; border-radius: 1mm; }
.pr-bar em { position: absolute; top: -1mm; bottom: -1mm; width: .7mm; margin-left: -.35mm; background: #d1271c; }
.pr-v b { font-size: 12pt; color: #4c0297; font-variant-numeric: tabular-nums; }
.pr-n { margin-top: 2mm; }
.gl-v { font-size: 20pt; font-weight: 900; color: #4c0297; font-variant-numeric: tabular-nums; }
.gl-l { font-size: 8.8pt; font-weight: 600; }
.gl-d { font-size: 7.8pt; color: #52514e; }
p.prose { text-align: left; }
p.prose.hyp { color: #2c2b29; }
.hyp-l { font-size: 7.5pt; font-weight: 700; color: #4c0297; background: #ede5ff; padding: .3mm 1.4mm; border-radius: 1.2mm; }
.actions { margin: 2mm 0 4mm; }
.ag { margin: 0 0 3mm; break-inside: avoid; }
.ag-t { font-weight: 700; }
.ag-h { font-weight: 400; color: #52514e; }
.ag ul { margin: 1mm 0 0; padding-left: 6mm; }
.ag li { margin: .8mm 0; }
.pair-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; }
.pair-t { font-size: 9pt; font-weight: 600; color: #52514e; margin-bottom: 1mm; }
.fiche section { break-before: auto; }
.fiche section.fiche-src { break-before: page; }
.fiche section.target { break-before: page; }
.target-k { font-size: 10pt; font-weight: 700; color: #d1271c; text-decoration: underline; text-underline-offset: 1.2mm; display: flex; align-items: center; gap: 2mm; }
.target-k .dot { width: 3.5mm; height: 3.5mm; border-radius: 50%; display: inline-block; }
h3.target-t { font-size: 24pt; font-weight: 900; color: #4c0297; text-transform: uppercase; margin: 1mm 0 1mm; }
.target-f { font-style: italic; color: #2c2b29; margin-bottom: 2mm; }
.fiche-src .biblio li { font-size: 7.8pt; }
td.sb { white-space: nowrap; }
.sbar { display: inline-block; vertical-align: middle; width: 16mm; height: 2.2mm; background: #ebe7de; border-radius: 1mm; margin-right: 1.5mm; overflow: hidden; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sbar > span { display: block; height: 100%; }
figure.poster svg { width: 100%; height: auto; max-height: 238mm; display: block; }
figure.poster { break-inside: avoid; margin-bottom: 2mm; }
.oa { border: 0.3mm solid #212320; padding: 3mm 4mm; margin: 0 0 2mm; font-size: 8.6pt; }
.oa-t { margin: 0 0 2mm; color: #4c0297; font-size: 11pt; font-weight: 800; }
.oa-g { break-inside: avoid; margin-bottom: 2mm; }
.oa-gt { font-weight: 700; color: #52514e; font-size: 8pt; margin-bottom: 1mm; }
.oa ol { list-style: none; margin: 0; padding: 0; columns: 2; column-gap: 6mm; }
.oa li { display: flex; gap: 2mm; break-inside: avoid; margin-bottom: 1.6mm; line-height: 1.3; }
.oa-b { flex: none; width: 5mm; height: 5mm; border-radius: 50%; color: #fff; font-weight: 800; font-size: 7.5pt; display: inline-flex; align-items: center; justify-content: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.oa-b.oa-square { border-radius: 1mm; }
.oa-b.oa-diamond { border-radius: 1mm; clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); width: 6mm; height: 6mm; }
.oa-q { color: #52514e; font-style: italic; }
/* Fiche destinée à des non-spécialistes : pas d'appels de note dans le texte (les sources restent listées en fin de fiche). */
.fiche section:not(.fiche-src) sup, .fiche section:not(.fiche-src) .refs { display: none; }
/* Feuilles de porte-à-porte : une page par bureau. */
#part-PORTE h3.fh { break-before: page; }
#part-PORTE h3.fh:first-of-type { break-before: auto; }
#part-PORTE figure.map svg { max-height: 92mm; width: auto; margin: 0 auto; }
#part-PORTE figure.map { break-inside: avoid; margin-top: 2mm; }
#part-PORTE td:first-child { font-size: 11pt; width: 9mm; text-align: center; }
`;

/**
 * Variante « Yonne » de la fiche : reprend la mise en page du document Word de
 * référence (Arial, titres soulignés, couleur propre à chaque proposition de
 * ciblage, tableaux quadrillés à en-tête teinté, listes à puces simples).
 */
export const YONNE_CSS = `
.yonne { --tc: #7b13d6; font-family: Arial, "Liberation Sans", Helvetica, sans-serif; font-size: 11pt; line-height: 1.4; color: #000; }
.yonne p { text-align: left; }
.yonne .y-head { margin-bottom: 6mm; }
.yonne .y-pole { font-size: 16pt; text-decoration: underline; text-underline-offset: 1mm; }
.yonne .y-dt { font-size: 16pt; }
.yonne .y-disc { font-size: 10pt; font-style: italic; margin-top: 4mm; }
.yonne .y-tl { font-size: 12pt; margin: 4mm 0 1mm; }
.yonne .y-terr { font-size: 12pt; font-weight: 700; margin: 0; }
.yonne .y-pc, .yonne .target-k { color: var(--tc); font-size: 14pt; font-weight: 400; text-decoration: underline; text-underline-offset: 1mm; margin-top: 4mm; }
.yonne .target-k .dot { display: none; }
.yonne .y-nom, .yonne h3.target-t { color: var(--tc); font-size: 14pt; font-weight: 400; margin: 0 0 3mm; }
.yonne .target-f { color: var(--tc); font-style: normal; font-size: 12pt; }
.yonne h3.fh { color: var(--tc); font-size: 14pt; font-weight: 400; border: 0; padding: 0; margin: 7mm 0 2mm; }
.yonne h4 { color: #000; font-size: 11pt; text-decoration: underline; }
.yonne ul.yl, .yonne ul.list, .yonne .ag ul { padding-left: 6mm; margin: 1mm 0 3mm; }
.yonne ul.yl li { margin: .8mm 0; }
.yonne .ag-t { font-weight: 400; text-decoration: underline; }
.yonne .ag-h { color: #000; }
.yonne table { font-size: 9.5pt; border: 1px solid #000; }
.yonne th { background: color-mix(in srgb, var(--tc) 30%, #fff); border: 1px solid #000; font-weight: 700; text-align: center; }
.yonne td { border: 1px solid #000; }
.yonne tr.hl td { background: #fff; color: var(--tc); font-weight: 700; }
.yonne figcaption { font-weight: 400; font-style: italic; text-align: center; }
.yonne .callout, .yonne .callout.accent, .yonne .callout.info, .yonne .callout.warning { border: 1px solid #000; background: #fff; }
.yonne .callout.terrain { border-color: #000; background: #fff; }
.yonne .note { background: #fff; padding: 0; font-size: 9pt; color: #000; }
.yonne .src, .yonne .refs, .yonne sup { color: #555; }
.yonne h2 { color: #000; border-bottom: 1px solid #000; font-size: 14pt; }
.yonne p.prose.hyp .hyp-l { background: none; color: #000; text-transform: none; letter-spacing: 0; font-size: 9pt; text-decoration: underline; }
`;

export function renderReportHtml(r: Report, opts: { standalone?: boolean; sectionIds?: string[]; style?: FicheStyle } = {}): string {
  const style = opts.style ?? "moderne";
  const cit = new Citations();
  const sections = opts.sectionIds ? r.sections.filter((s) => opts.sectionIds!.includes(s.id)) : r.sections;
  // Le corps est rendu en premier pour numéroter les sources dans l'ordre d'apparition.
  const body = opts.sectionIds
    ? ""
    : sections.map((s) => `<section class="part" id="part-${s.id}"><h2>${s.letter ? `${s.letter}. ` : ""}${esc(s.title)}</h2>${blocksHtml(r, s.blocks, cit)}</section>`)
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

  const scopeLabel = { commune: "Commune", epci: "Intercommunalité", circonscription: "Circonscription législative", departement: "Département", custom: "Territoire personnalisé" }[r.query.scope];
  const cover = `<section class="cover"><div><div class="kicker">${isTerritorial(r) ? "Développement territorial" : "Diagnostic territorial"}</div><h1>${esc(isTerritorial(r) ? territoryName(r) : r.commune.nom)}</h1><div class="sub">${esc(r.commune.departement.nom)} (${esc(r.commune.departement.code)}) · ${esc(r.commune.region.nom)}${r.commune.epci ? ` · ${esc(r.commune.epci.nom)}` : ""}</div><p class="sub" style="margin-top:4mm">Périmètre d'analyse : ${esc(scopeLabel)} — ${esc(r.perimeter.label)}</p>
${splitWarnings(r).main.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}
<div class="warn" style="border-color:#2a78d6;background:#eef5fd">Ce document est produit automatiquement à partir de statistiques publiques agrégées. Ses constats doivent être confrontés à la connaissance de terrain des acteurs locaux.</div></div>
<div class="toc"><h3>Sommaire</h3><ul style="list-style:none;padding-left:0">${r.sections.map((s) => `<li>${s.letter ? `<strong>${s.letter}.</strong> ` : "★ "}${esc(s.title)}</li>`).join("")}</ul><p>Annexe : méthodologie, journal de collecte et bibliographie.</p></div>
<div class="meta">Code INSEE ${esc(r.commune.code)} · Généré le ${esc(fmtDate(r.updatedAt))} (version ${r.version}) · Identifiant ${esc(r.id)}<br>Fraîcheur des données : ${esc(freshness(r))}</div></section>`;

  // Version courte (fiche d'action) : en-tête sur le modèle des fiches « Développement
  // territorial », corps sans titre de partie, sources en petit corps.
  if (opts.sectionIds) {
    const ciblage = sections.some((s) => s.id === "CIBLAGE");
    const head = style === "yonne"
      ? `<header class="y-head"><div class="y-pole">Pôle d'études électorales</div><div class="y-dt">Développement territorial</div><div class="y-dt">${esc(ciblage ? territoryName(r) : `${r.commune.nom} (${r.commune.departement.nom})`)}</div></header>${ciblage ? "" : `<div class="y-pc">Proposition de ciblage</div><div class="y-nom">${esc(r.commune.nom)}</div>`}`
      : ciblage
      ? `<header class="fiche-head"><div class="fiche-k">Propositions de ciblage ${r.query.scope === "circonscription" ? "de la circonscription" : r.query.scope === "epci" ? "de l'intercommunalité" : "du département"}</div><h1${titleClass(territoryName(r))}>${esc(territoryName(r))}</h1><div class="fiche-sub">${esc(r.commune.region.nom)}</div><div class="fiche-meta">Généré le ${esc(fmtDate(r.updatedAt))}, version ${r.version}</div></header>`
      : `<header class="fiche-head"><div class="fiche-k">Proposition de ciblage</div><h1${titleClass(r.commune.nom)}>${esc(r.commune.nom)}</h1><div class="fiche-sub">${esc(r.commune.departement.nom)} (${esc(r.commune.departement.code)}), ${esc(r.commune.region.nom)}${r.commune.epci ? `. ${esc(r.commune.epci.nom)}` : ""}</div><div class="fiche-meta">Code INSEE ${esc(r.commune.code)}, généré le ${esc(fmtDate(r.updatedAt))}, version ${r.version}</div></header>`;
    const shortBody = sections.map((s) => `<section id="part-${s.id}">${s.id === "LFI" || s.id === "CIBLAGE" ? "" : `<h2>${s.letter ? `${s.letter}. ` : ""}${esc(s.title)}</h2>`}${blocksHtml(r, s.blocks, cit, style)}</section>`).join("\n");
    const biblio = `<section class="part fiche-src"><h2>Sources</h2><ol class="biblio">${cit
      .all()
      .map((s) => `<li>${esc(sourceLabel(s))}. Consulté le ${esc(fmtDate(s.retrievedAt))}. <a href="${esc(s.url)}">${esc(s.url.length > 140 ? s.url.slice(0, 137) + "…" : s.url)}</a></li>`)
      .join("")}</ol></section>`;
    const short = `<div class="fiche${style === "yonne" ? " yonne" : ""}">${head}${shortBody}${biblio}</div>`;
    if (opts.standalone === false) return short;
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${ciblage ? `Développement territorial — ${esc(territoryName(r))}` : `Fiche d'action — ${esc(r.commune.nom)}`}</title><style>${REPORT_CSS}${style === "yonne" ? YONNE_CSS : ""}</style></head><body>${short}</body></html>`;
  }
  const html = `${cover}\n${body}\n${method}`;
  if (opts.standalone === false) return html;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(docTitle(r, false))}</title><style>${REPORT_CSS}</style></head><body>${html}</body></html>`;
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
