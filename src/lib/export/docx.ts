import { splitWarnings } from "../report/warnings";
import { presenceSvg } from "../render/presence";
import { posterItems } from "../render/poster";
import { Resvg } from "@resvg/resvg-js";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { SOURCES } from "../collectors/catalog";
import { KIND_LABELS } from "../analysis/findings";
import { fmtDate, fmtValue, territoryName } from "../format";
import { cellText, Citations, freshness, selectFindings, sourceLabel } from "../render/html";
import { inlineParts } from "../render/cite";
import { chartSvg, hasLocator, locatorSvg, mapSvg } from "../render/svg";
import type { Block, DataTable, Indicator, Report, SourceRef } from "../types";
import { FIELD_NOTE_LABELS } from "../types";

/**
 * Export DOCX modifiable : styles de titres Word (sommaire automatique),
 * tableaux natifs éditables, graphiques et cartes insérés en images PNG,
 * notes de sources numérotées et bibliographie.
 */

let FONT = "Calibri";
const BLUE = "0D366B";

/** Thème courant : « moderne » (diagnostic complet) ou « yonne » (fiche seule, modèle Word de référence). */
let THEME = { yonne: false, color: "7B13D6", head: "F3F6FB", hl: "F7F9FC", rule: "B7D3F6", inner: "EEEEEC" };
const MODERNE = { ...THEME };
const tint = (hex: string, k = 0.3) => {
  const n = parseInt(hex.replace("#", ""), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(255 - (255 - v) * k));
  return c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
};

function svgToPng(svg: string, width = 1400): { data: Buffer; w: number; h: number } {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" }, background: "#ffffff" });
  const img = r.render();
  return { data: img.asPng(), w: img.width, h: img.height };
}

function image(svg: string, maxWidthPx = 600) {
  const png = svgToPng(svg);
  const w = Math.min(maxWidthPx, 600);
  return new Paragraph({ children: [new ImageRun({ type: "png", data: png.data, transformation: { width: w, height: Math.round((png.h / png.w) * w) } })] });
}

/** Segments `**gras**` → TextRun. */
const runs = (text: string, o: { size?: number; color?: string; italics?: boolean; bold?: boolean } = {}) =>
  text.split("\n").flatMap((line, li) =>
    inlineParts(line).map((s, i) => new TextRun({ text: s.text, font: FONT, size: o.size ?? 21, color: o.color, italics: o.italics, bold: o.bold || s.bold, break: li > 0 && i === 0 ? 1 : undefined })),
  );

const p = (text: string, opts: { bold?: boolean; size?: number; color?: string; italics?: boolean } = {}) =>
  new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, font: FONT, bold: opts.bold, size: opts.size ?? 21, color: opts.color, italics: opts.italics })] });

const small = (text: string) => new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text, font: FONT, size: 16, color: "52514E" })] });

/** Liste « Où agir » sous la carte affiche (texte Word, et non dans l'image). */
function posterListDocx(m: Parameters<typeof posterItems>[0]): Paragraph[] {
  const items = posterItems(m);
  if (!items.length) return [];
  const out: Paragraph[] = [new Paragraph({ spacing: { before: 120, after: 60 }, keepNext: true, children: [new TextRun({ text: "Où agir", font: FONT, bold: true, size: 22, color: "4C0297" })] })];
  let group = "";
  for (const it of items) {
    if (it.group !== group) {
      group = it.group;
      out.push(new Paragraph({ spacing: { before: 80, after: 30 }, keepNext: true, children: [new TextRun({ text: it.action !== it.group ? `${it.action} — ${it.group}` : it.group, font: FONT, bold: true, size: 18, color: "52514E" })] }));
    }
    const lines = [...(it.det.length ? it.det : [it.sub]).filter(Boolean), ...(it.quand ? [`Quand : ${it.quand}`] : [])];
    out.push(
      new Paragraph({
        spacing: { after: 50 },
        indent: { left: 360, hanging: 360 },
        children: [
          new TextRun({ text: `${it.n}. `, font: FONT, bold: true, size: 19, color: it.color.replace("#", "").toUpperCase() }),
          new TextRun({ text: it.nom, font: FONT, bold: true, size: 19 }),
          ...lines.map((l) => new TextRun({ text: l, font: FONT, size: 18, color: "3A3936", break: 1 })),
        ],
      }),
    );
  }
  return out;
}

const caption = (text: string) => new Paragraph({ spacing: { before: 200, after: 80 }, keepNext: true, children: [new TextRun({ text, font: FONT, bold: true, size: 20 })] });

function cellP(text: string, bold = false, right = false, hl = false) {
  return new TableCell({
    children: [new Paragraph({ alignment: THEME.yonne && bold ? AlignmentType.CENTER : right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: runs(text, { size: THEME.yonne ? 18 : 17, bold: bold || hl, color: THEME.yonne && hl ? THEME.color : undefined }) })],
    shading: bold ? { type: ShadingType.CLEAR, color: "auto", fill: THEME.head } : hl && !THEME.yonne ? { type: ShadingType.CLEAR, color: "auto", fill: THEME.hl } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
  });
}

function table(headers: string[], rows: string[][], rightCols: number[] = [], highlight: number[] = []) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: THEME.yonne
      ? (() => {
          const l = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
          return { top: l, bottom: l, left: l, right: l, insideHorizontal: l, insideVertical: l };
        })()
      : {
      top: { style: BorderStyle.SINGLE, size: 4, color: "B7D3F6" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "B7D3F6" },
      left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "EEEEEC" },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cellP(h, true, rightCols.includes(i))) }),
      ...rows.map((r, k) => new TableRow({ cantSplit: true, children: r.map((c, i) => cellP(c, false, rightCols.includes(i), highlight.includes(k))) })),
    ],
  });
}

function dataTable(t: DataTable, cit: Citations) {
  const right = t.columns.map((c, i) => (c.align === "right" ? i : -1)).filter((i) => i >= 0);
  // Score de 0 à 100 : barre en caractères (dix crans) dans Word.
  const bar = (v: number) => `${"█".repeat(Math.round(v / 10))}${"░".repeat(10 - Math.round(v / 10))} ${v}`;
  const rows = t.rows.map((r) => t.columns.map((c) => (c.bar && typeof r[c.key] === "number" ? bar(r[c.key] as number) : cellText(r[c.key], c.unit ?? (c.key !== "indicateur" && c.key !== "annee" ? (r.unite as string | undefined) : undefined)))));
  return [caption(t.title), table(t.columns.map((c) => c.label), rows, right, t.highlight ?? []), small(`Sources : ${[...new Set(t.sources.map((s) => `[${cit.cite(s)}]`))].join(" ")}${t.note ? ` — ${t.note}` : ""}`)];
}

function indicatorFor(r: Report, id: string) {
  return r.indicators.find((i) => i.id === id && i.geo.level === r.focus.level && (r.focus.level !== "commune" || i.geo.code === r.commune.code));
}

function blockDocx(r: Report, b: Block, cit: Citations): (Paragraph | Table)[] {
  const refsOf = (ev: string[] = []) =>
    [...new Set(ev.map((e) => r.indicators.find((i) => `${i.id}@${i.geo.level}:${i.geo.code}` === e)).filter(Boolean).map((i) => cit.cite(i!.source)))];
  switch (b.type) {
    case "paragraph": {
      const refs = refsOf(b.evidence);
      return [new Paragraph({ spacing: { after: 140 }, alignment: AlignmentType.JUSTIFIED, children: [...runs(b.text), ...(refs.length ? [new TextRun({ text: " " + refs.map((n) => `[${n}]`).join(""), font: FONT, size: 16, color: "8A8984" })] : [])] })];
    }
    case "kpis": {
      const items = b.indicatorIds.map((id) => indicatorFor(r, id)).filter((i): i is Indicator => !!i && i.value != null);
      if (!items.length) return [];
      return [caption("Indicateurs clés"), table(["Indicateur", "Valeur", "Millésime", "Source"], items.map((i) => [i.label, fmtValue(i.value, i.unit), i.year ?? "", `[${cit.cite(i.source)}]`]), [1])];
    }
    case "comparison": {
      const geos = r.references;
      const rows = b.indicatorIds
        .map((id) => {
          const vals = geos.map((g) => r.indicators.find((i) => i.id === id && i.geo.level === g.level && i.geo.code === g.code));
          const base = vals.find(Boolean);
          if (!base || !vals.some((v) => v?.value != null)) return null;
          return [base.label, vals[0]?.year ?? base.year ?? "", ...vals.map((v) => (v?.value != null ? `${fmtValue(v.value, v.unit)} [${cit.cite(v.source)}]` : "n.d."))];
        })
        .filter((x): x is string[] => !!x);
      if (!rows.length) return [];
      return [caption(b.title ?? "Comparaison"), table(["Indicateur", "Millésime", ...geos.map((g) => g.name)], rows, geos.map((_, i) => i + 2)), small("n.d. : non disponible.")];
    }
    case "table": {
      const t = r.tables.find((x) => x.id === b.tableId);
      return t ? dataTable(t, cit) : [];
    }
    case "chart": {
      const c = r.charts.find((x) => x.id === b.chartId);
      if (!c) return [];
      return [caption(c.title), image(chartSvg(c)), small(`Sources : ${[...new Set(c.sources.map((s) => `[${cit.cite(s)}]`))].join(" ")}${c.note ? ` — ${c.note}` : ""}`)];
    }
    case "map": {
      const m = r.maps.find((x) => x.id === b.mapId);
      if (!m) return [];
      const srcs = [...new Map(m.layers.map((l) => [l.source.id + l.source.url, l.source])).values()];
      if (m.poster) return [image(mapSvg(m, 720, 540, { posterList: false }), 600), ...posterListDocx(m), small(`Sources : ${[...new Set(srcs.map((s) => `[${cit.cite(s)}]`))].join(" ")}${m.note ? ` — ${m.note}` : ""}`)];
      return [caption(m.title), image(mapSvg(m), 560), small(`Sources : ${[...new Set(srcs.map((s) => `[${cit.cite(s)}]`))].join(" ")} · Fond : contours ADMIN EXPRESS (IGN) via geo.api.gouv.fr${m.note ? ` — ${m.note}` : ""}`)];
    }
    case "locator": {
      if (!hasLocator(r.commune.departement.code)) return [];
      const s: SourceRef = { id: "svgmaps", name: SOURCES.svgmaps.name, url: SOURCES.svgmaps.homepage, retrievedAt: r.createdAt };
      return [caption(`Localisation du département ${r.commune.departement.nom}`), image(locatorSvg(r.commune.departement.code, r.commune.departement.nom, 500), 280), small(`Fond : [${cit.cite(s)}] (CC BY 4.0)`)];
    }
    case "note":
      return [new Paragraph({ spacing: { after: 140 }, shading: { type: ShadingType.CLEAR, color: "auto", fill: "F6F6F4" }, children: runs(b.text, { size: 18, color: "52514E" }) })];
    case "callout": {
      const color = b.tone === "accent" ? "C0503A" : b.tone === "info" ? "B7D3F6" : "0B0B0B";
      const side = { style: BorderStyle.SINGLE, size: b.tone === "warning" ? 12 : 8, color, space: 6 };
      return [
        new Paragraph({
          spacing: { before: 120, after: 200 },
          border: { top: side, bottom: side, left: side, right: side },
          shading: b.tone === "accent" ? { type: ShadingType.CLEAR, color: "auto", fill: "FDF6F3" } : b.tone === "info" ? { type: ShadingType.CLEAR, color: "auto", fill: "F3F7FD" } : undefined,
          children: [...(b.title ? [new TextRun({ text: b.title + " — ", font: FONT, size: 20, bold: true })] : []), ...runs(b.text, { size: 20 })],
        }),
      ];
    }
    case "heading":
      if (THEME.yonne) return [new Paragraph({ spacing: { before: 280, after: 100 }, keepNext: true, children: [new TextRun({ text: b.text, font: FONT, size: 28, color: THEME.color })] })];
      return [new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: b.text, font: FONT })] })];
    case "targets":
      return b.items.flatMap((t, k) => {
        const tb = r.tables.find((x) => x.id === t.tableId);
        if (THEME.yonne) {
          const prev = THEME.color;
          const c = t.color.replace("#", "").toUpperCase();
          THEME = { ...THEME, color: c, head: tint(c) };
          const out = [
            new Paragraph({ pageBreakBefore: true, children: [new TextRun({ text: `Proposition de ciblage n°${k + 1}`, font: FONT, size: 28, color: c, underline: {} })] }),
            new Paragraph({ children: [new TextRun({ text: t.nom, font: FONT, size: 28, color: c })] }),
            ...(t.focus?.length ? [new Paragraph({ children: [new TextRun({ text: `(Focus possibles : ${t.focus.join(", ")})`, font: FONT, size: 24, color: c })] })] : []),
            new Paragraph({ spacing: { before: 120 }, children: [] }),
            ...t.raisons.map((x) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: runs(x) })),
            ...(tb ? dataTable(tb, cit) : []),
          ];
          THEME = { ...THEME, color: prev, head: tint(prev) };
          return out;
        }
        return [
          new Paragraph({ pageBreakBefore: true, children: [new TextRun({ text: `Proposition de ciblage n°${k + 1}`, font: FONT, size: 21, bold: true, underline: {} })] }),
          new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t.nom, font: FONT })] }),
          ...(t.focus?.length ? [p(`Focus possibles : ${t.focus.join(", ")}`, { italics: true })] : []),
          ...t.raisons.map((x) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: runs(x, { size: 19 }) })),
          ...(tb ? dataTable(tb, cit) : []),
        ];
      });
    case "fieldPlaces": {
      const items = r.fieldPlaces?.items ?? [];
      if (!items.length) return [];
      const rows = [...items].sort((a, b) => Number(!!b.prioritaire) - Number(!!a.prioritaire) || a.type.localeCompare(b.type));
      return [
        caption(`Lieux d'action signalés par les militants (${fmtDate(r.fieldPlaces!.updatedAt)})`),
        table(
          ["Type", "Lieu", "Jours et horaires", "Adresse", "Bureau"],
          rows.map((p) => [p.type, p.nom, p.horaires, p.adresse, p.bv ? `BV ${p.bv}${p.prioritaire ? " (prioritaire)" : ""}` : ""]),
          [],
          rows.map((p, i) => (p.prioritaire ? i : -1)).filter((i) => i >= 0),
        ),
        new Paragraph({ spacing: { after: 160 }, children: [] }),
      ];
    }
    case "fieldNotes": {
      const n = b.part ? r.fieldNotes?.parts?.[b.part] : r.fieldNotes;
      if (!n?.text.trim()) return [];
      const side = { style: BorderStyle.SINGLE, size: 8, color: "1BAF7A", space: 6 };
      return [
        new Paragraph({
          spacing: { before: 120, after: 200 },
          border: { top: side, bottom: side, left: side, right: side },
          shading: { type: ShadingType.CLEAR, color: "auto", fill: "F1FAF6" },
          children: [new TextRun({ text: `${FIELD_NOTE_LABELS[b.part ?? "general"].title} (${fmtDate(n.updatedAt)}) — `, font: FONT, size: 20, bold: true }), ...runs(n.text.trim(), { size: 20 })],
        }),
      ];
    }
    case "glance":
      if (THEME.yonne) return b.items.map((i) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: runs(`${i.label} : **${i.value}**${i.detail ? ` (${i.detail})` : ""}`) }));
      return [
        table(
          b.items.map((i) => i.label),
          [b.items.map((i) => `**${i.value}**`), b.items.map((i) => i.detail ?? "")],
          b.items.map((_, i) => i),
        ),
        new Paragraph({ spacing: { after: 120 }, children: [] }),
      ];
    case "presence": {
      const png = svgToPng(presenceSvg(b), 1400);
      const w = 600;
      return [
        caption(b.title),
        new Paragraph({ children: [new ImageRun({ type: "png", data: png.data, transformation: { width: w, height: Math.round((png.h / png.w) * w) } })] }),
        ...(b.note ? [new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: b.note, font: FONT, size: 16, color: "52514E" })] })] : []),
      ];
    }
    case "actions":
      return [
        ...(b.title ? [new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: b.title, font: FONT })] })] : []),
        ...b.groups.flatMap((g) => [
          new Paragraph({ spacing: { before: 120, after: 40 }, keepNext: true, children: [new TextRun({ text: g.title, font: FONT, size: 20, bold: !THEME.yonne, underline: THEME.yonne ? {} : undefined }), ...(g.hint ? [new TextRun({ text: ` (${g.hint})`, font: FONT, size: 20, color: "52514E" })] : []), new TextRun({ text: " :", font: FONT, size: 20, bold: true })] }),
          ...g.items.map((i) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: runs(i, { size: 19 }) })),
        ]),
      ];
    case "mapPair": {
      const ms = b.mapIds.map((id) => r.maps.find((x) => x.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
      if (!ms.length) return [];
      const srcs = [...new Map(ms.flatMap((m) => m.layers.map((l) => [l.source.id + l.source.url, l.source] as const))).values()];
      const pngs = ms.map((m) => svgToPng(mapSvg(m, 420, 470), 900));
      const w = 300;
      return [
        caption(b.title ?? ms.map((m) => m.title).join(" / ")),
        new Paragraph({ children: pngs.flatMap((png, i) => [...(i ? [new TextRun({ text: "  " })] : []), new ImageRun({ type: "png", data: png.data, transformation: { width: w, height: Math.round((png.h / png.w) * w) } })]) }),
        small(`${ms.map((m) => m.period ?? m.title).join(" (à gauche) / ")} (à droite). Sources : ${[...new Set(srcs.map((s) => `[${cit.cite(s)}]`))].join(" ")}${ms[0].note ? ` — ${ms[0].note}` : ""}`),
      ];
    }
    case "missing": {
      const items = r.missing.filter((m) => !b.themes.length || b.themes.includes(m.theme));
      if (!items.length) return [];
      return [p("Données manquantes ou non intégrées", { bold: true, size: 19 }), ...items.map((m) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: `${m.label} — ${m.reason}`, font: FONT, size: 18 })] }))];
    }
    case "findings": {
      const fs = selectFindings(r, b);
      const out: Paragraph[] = [];
      if (b.title) out.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: b.title, font: FONT })] }));
      if (!fs.length) return b.title ? [...out, p("Aucun élément relevé automatiquement.", { italics: true, color: "8A8984" })] : [];
      for (const f of fs) {
        const refs = refsOf(f.evidence);
        if (b.style === "prose") {
          out.push(
            new Paragraph({
              spacing: { after: 140 },
              children: [
                ...(f.kind === "hypothese" ? [new TextRun({ text: "Hypothèse — ", font: FONT, size: 19, bold: true, color: "4A3AA7" })] : []),
                ...runs(f.text),
                ...(refs.length ? [new TextRun({ text: " " + refs.map((n) => `[${n}]`).join(""), font: FONT, size: 15, color: "8A8984" })] : []),
              ],
            }),
          );
          continue;
        }
        out.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 60 },
            children: [
              new TextRun({ text: `${KIND_LABELS[f.kind]} — `, font: FONT, size: 19, bold: true, color: f.kind === "vigilance" ? "A12A29" : f.kind === "atout" ? "0B6B47" : "1C5CAB" }),
              ...runs(f.text, { size: 19 }),
              ...(refs.length ? [new TextRun({ text: " " + refs.map((n) => `[${n}]`).join(""), font: FONT, size: 15, color: "8A8984" })] : []),
            ],
          }),
        );
      }
      return out;
    }
    case "list":
      return [
        ...(b.title ? [new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: b.title, font: FONT })] })] : []),
        ...b.items.map(
          (i) =>
            new Paragraph({
              bullet: { level: 0 },
              children: [...runs(i.text, { size: 19 }), ...(refsOf(i.evidence).length ? [new TextRun({ text: " " + refsOf(i.evidence).map((n) => `[${n}]`).join(""), font: FONT, size: 15, color: "8A8984" })] : []), ...(i.url ? [new TextRun({ text: " — ", font: FONT, size: 19 }), new ExternalHyperlink({ link: i.url, children: [new TextRun({ text: i.url, style: "Hyperlink", font: FONT, size: 17 })] })] : [])],
            }),
        ),
      ];
  }
}

/**
 * Fiche seule au format Word, sur le modèle du document de référence
 * « Développement territorial » : Arial, titres soulignés, une couleur par
 * proposition de ciblage, tableaux quadrillés, listes à puces simples.
 */
async function ficheToDocx(r: Report, sectionIds: string[]): Promise<Buffer> {
  const cit = new Citations();
  const sections = r.sections.filter((s) => sectionIds.includes(s.id));
  const ciblage = sections.some((s) => s.id === "CIBLAGE");
  FONT = "Arial";
  THEME = { yonne: true, color: "7B13D6", head: tint("7B13D6"), hl: "FFFFFF", rule: "000000", inner: "000000" };
  let doc: Document;
  // Construction synchrone : le thème global est rétabli avant tout `await`.
  try {
    const body: (Paragraph | Table)[] = [];
    for (const s of sections) for (const b of s.blocks) body.push(...blockDocx(r, b, cit));
    const head = [
      new Paragraph({ children: [new TextRun({ text: "Pôle d'études électorales", font: FONT, size: 32, underline: {} })] }),
      new Paragraph({ children: [new TextRun({ text: "Développement territorial", font: FONT, size: 32 })] }),
      new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: ciblage ? territoryName(r) : `${r.commune.nom} (${r.commune.departement.nom})`, font: FONT, size: 32 })] }),
      ...(ciblage
        ? []
        : [
            new Paragraph({ children: [new TextRun({ text: "Proposition de ciblage", font: FONT, size: 28, color: THEME.color, underline: {} })] }),
            new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: r.commune.nom, font: FONT, size: 28, color: THEME.color })] }),
          ]),
    ];
    const biblio = [
      new Paragraph({ pageBreakBefore: true, spacing: { after: 120 }, children: [new TextRun({ text: "Sources", font: FONT, size: 28, underline: {} })] }),
      ...cit.all().map(
        (s, i) =>
          new Paragraph({
            spacing: { after: 60 },
            children: [
              new TextRun({ text: `[${i + 1}] ${sourceLabel(s)}. Consulté le ${fmtDate(s.retrievedAt)}. `, font: FONT, size: 16 }),
              new ExternalHyperlink({ link: s.url, children: [new TextRun({ text: s.url.length > 120 ? s.url.slice(0, 117) + "…" : s.url, style: "Hyperlink", font: FONT, size: 14 })] }),
            ],
          }),
      ),
    ];
    doc = new Document({
      creator: "fiche-territoriale",
      title: ciblage ? `Développement territorial — ${territoryName(r)}` : `Fiche d'action — ${r.commune.nom}`,
      styles: {
        default: { document: { run: { font: FONT, size: 22 } } },
        paragraphStyles: [
          { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 28, font: FONT }, paragraph: { spacing: { before: 240, after: 120 } } },
          { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 28, font: FONT, color: "7B13D6" }, paragraph: { spacing: { before: 240, after: 120 } } },
          { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 22, font: FONT, underline: {} }, paragraph: { spacing: { before: 200, after: 80 } } },
        ],
      },
      sections: [
        {
          properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
          footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18 })] })] }) },
          children: [...head, ...body, ...biblio],
        },
      ],
    });
  } finally {
    FONT = "Calibri";
    THEME = { ...MODERNE };
  }
  return Packer.toBuffer(doc);
}

export async function reportToDocx(r: Report, opts: { sectionIds?: string[]; style?: "moderne" | "yonne" } = {}): Promise<Buffer> {
  if (opts.sectionIds) return ficheToDocx(r, opts.sectionIds);
  const cit = new Citations();
  const body: (Paragraph | Table | TableOfContents)[] = [];
  for (const s of r.sections) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun({ text: s.letter ? `${s.letter}. ${s.title}` : s.title, font: FONT })] }));
    for (const b of s.blocks) body.push(...blockDocx(r, b, cit));
  }
  // Annexe
  body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun({ text: "Méthodologie, sources et limites", font: FONT })] }));
  body.push(
    p(
      "Calculs réalisés par un code déterministe et testé ; aucune valeur n'est estimée lorsqu'une donnée manque (« n.d. »). Écart significatif : au moins 2 points et 10 % en relatif pour un taux, 10 % en relatif pour les autres grandeurs. Valeurs atypiques : score z robuste ≥ 2 parmi les communes comparables. Petits effectifs : moins de 200 unités pour un ratio, moins de 30 ventes pour un prix médian.",
    ),
  );
  body.push(p(`Moteur de rédaction : ${r.narrativeEngine}.`));
  body.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Journal de collecte", font: FONT })] }));
  body.push(table(["Source", "Étape", "Statut", "Requêtes", "Message"], r.runs.map((x) => [x.name, x.step, x.status, String(x.requests), x.message ?? ""]), [3]));
  body.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Bibliographie des sources citées", font: FONT })] }));
  cit.all().forEach((s, i) =>
    body.push(
      new Paragraph({
        spacing: { after: 80 },
        children: [
          new TextRun({ text: `[${i + 1}] ${sourceLabel(s)}. ${SOURCES[s.id] ? `${SOURCES[s.id].producer}. Licence : ${SOURCES[s.id].license}. ` : ""}Consulté le ${fmtDate(s.retrievedAt)}. `, font: FONT, size: 17 }),
          new ExternalHyperlink({ link: s.url, children: [new TextRun({ text: s.url.length > 140 ? s.url.slice(0, 137) + "…" : s.url, style: "Hyperlink", font: FONT, size: 15 })] }),
        ],
      }),
    ),
  );

  const scopeLabel = { commune: "Commune", epci: "Intercommunalité", circonscription: "Circonscription législative", departement: "Département", custom: "Territoire personnalisé" }[r.query.scope];
  const cover = [
    new Paragraph({ spacing: { before: 1800 }, children: [new TextRun({ text: "DIAGNOSTIC TERRITORIAL", font: FONT, size: 22, color: "52514E" })] }),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: r.commune.nom, font: FONT, size: 64, bold: true, color: BLUE })] }),
    p(`${r.commune.departement.nom} (${r.commune.departement.code}) · ${r.commune.region.nom}${r.commune.epci ? ` · ${r.commune.epci.nom}` : ""}`, { size: 26, color: "52514E" }),
    p(`Périmètre d'analyse : ${scopeLabel} — ${r.perimeter.label}`, { size: 22 }),
    ...splitWarnings(r).main.map((w) => p(w, { italics: true, color: "8A5300", size: 19 })),
    p("Document produit automatiquement à partir de statistiques publiques agrégées ; ses constats doivent être confrontés à la connaissance de terrain des acteurs locaux.", { italics: true, size: 19 }),
    p(`Code INSEE ${r.commune.code} · Généré le ${fmtDate(r.updatedAt)} (version ${r.version}) · ${freshness(r)}`, { size: 17, color: "52514E" }),
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "Sommaire", font: FONT })] }),
    new TableOfContents("Sommaire", { hyperlink: true, headingStyleRange: "1-2" }),
    small("Le sommaire se met à jour à l'ouverture (ou via clic droit → Mettre à jour les champs)."),
  ];

  const doc = new Document({
    creator: "fiche-territoriale",
    title: `Diagnostic territorial — ${r.commune.nom}`,
    description: "Fiche générée automatiquement à partir de données publiques",
    features: { updateFields: true },
    styles: {
      default: { document: { run: { font: FONT, size: 21 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 32, bold: true, color: BLUE, font: FONT }, paragraph: { spacing: { after: 200 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 26, bold: true, color: "1C5CAB", font: FONT }, paragraph: { spacing: { before: 240, after: 120 } } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 22, bold: true, color: "1C5CAB", font: FONT }, paragraph: { spacing: { before: 200, after: 100 } } },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1000, bottom: 1000, left: 900, right: 900 } } },
        headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Diagnostic territorial — ${r.commune.nom} (${r.commune.code})`, font: FONT, size: 15, color: "8A8984" })] })] }) },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], font: FONT, size: 15, color: "8A8984" })] })],
          }),
        },
        children: [...cover, ...body],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
