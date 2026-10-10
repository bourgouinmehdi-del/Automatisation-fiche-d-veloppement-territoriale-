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
import { fmtDate, fmtValue } from "../format";
import { cellText, Citations, freshness, sourceLabel } from "../render/html";
import { chartSvg, hasLocator, locatorSvg, mapSvg } from "../render/svg";
import type { Block, DataTable, Indicator, Report, SourceRef } from "../types";

/**
 * Export DOCX modifiable : styles de titres Word (sommaire automatique),
 * tableaux natifs éditables, graphiques et cartes insérés en images PNG,
 * notes de sources numérotées et bibliographie.
 */

const FONT = "Calibri";
const BLUE = "0D366B";

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

const p = (text: string, opts: { bold?: boolean; size?: number; color?: string; italics?: boolean } = {}) =>
  new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, font: FONT, bold: opts.bold, size: opts.size ?? 21, color: opts.color, italics: opts.italics })] });

const small = (text: string) => new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text, font: FONT, size: 16, color: "52514E" })] });

const caption = (text: string) => new Paragraph({ spacing: { before: 200, after: 80 }, keepNext: true, children: [new TextRun({ text, font: FONT, bold: true, size: 20 })] });

function cellP(text: string, bold = false, right = false) {
  return new TableCell({
    children: [new Paragraph({ alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text, font: FONT, size: 17, bold })] })],
    shading: bold ? { type: ShadingType.CLEAR, color: "auto", fill: "F3F6FB" } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
  });
}

function table(headers: string[], rows: string[][], rightCols: number[] = []) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "B7D3F6" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "B7D3F6" },
      left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "EEEEEC" },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cellP(h, true, rightCols.includes(i))) }),
      ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => cellP(c, false, rightCols.includes(i))) })),
    ],
  });
}

function dataTable(t: DataTable, cit: Citations) {
  const right = t.columns.map((c, i) => (c.align === "right" ? i : -1)).filter((i) => i >= 0);
  const rows = t.rows.map((r) => t.columns.map((c) => cellText(r[c.key], c.unit ?? (c.key !== "indicateur" && c.key !== "annee" ? (r.unite as string | undefined) : undefined))));
  return [caption(t.title), table(t.columns.map((c) => c.label), rows, right), small(`Sources : ${t.sources.map((s) => `[${cit.cite(s)}]`).join(" ")}${t.note ? ` — ${t.note}` : ""}`)];
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
      return [new Paragraph({ spacing: { after: 140 }, alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text: b.text, font: FONT, size: 21 }), ...(refs.length ? [new TextRun({ text: " " + refs.map((n) => `[${n}]`).join(""), font: FONT, size: 16, color: "8A8984" })] : [])] })];
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
      return [caption(c.title), image(chartSvg(c)), small(`Sources : ${c.sources.map((s) => `[${cit.cite(s)}]`).join(" ")}${c.note ? ` — ${c.note}` : ""}`)];
    }
    case "map": {
      const m = r.maps.find((x) => x.id === b.mapId);
      if (!m) return [];
      const srcs = [...new Map(m.layers.map((l) => [l.source.id + l.source.url, l.source])).values()];
      return [caption(m.title), image(mapSvg(m), 560), small(`Sources : ${srcs.map((s) => `[${cit.cite(s)}]`).join(" ")} · Fond : contours ADMIN EXPRESS (IGN) via geo.api.gouv.fr${m.note ? ` — ${m.note}` : ""}`)];
    }
    case "locator": {
      if (!hasLocator(r.commune.departement.code)) return [];
      const s: SourceRef = { id: "svgmaps", name: SOURCES.svgmaps.name, url: SOURCES.svgmaps.homepage, retrievedAt: r.createdAt };
      return [caption(`Localisation du département ${r.commune.departement.nom}`), image(locatorSvg(r.commune.departement.code, r.commune.departement.nom, 500), 280), small(`Fond : [${cit.cite(s)}] (CC BY 4.0)`)];
    }
    case "note":
      return [new Paragraph({ spacing: { after: 140 }, shading: { type: ShadingType.CLEAR, color: "auto", fill: "F6F6F4" }, children: [new TextRun({ text: b.text, font: FONT, size: 18, color: "52514E" })] })];
    case "missing": {
      const items = r.missing.filter((m) => !b.themes.length || b.themes.includes(m.theme));
      if (!items.length) return [];
      return [p("Données manquantes ou non intégrées", { bold: true, size: 19 }), ...items.map((m) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: `${m.label} — ${m.reason}`, font: FONT, size: 18 })] }))];
    }
    case "findings": {
      const fs = r.findings.filter((f) => (!b.kinds || b.kinds.includes(f.kind)) && (!b.themes || b.themes.includes(f.theme)));
      const out: Paragraph[] = [];
      if (b.title) out.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: b.title, font: FONT })] }));
      if (!fs.length) return b.title ? [...out, p("Aucun élément relevé automatiquement.", { italics: true, color: "8A8984" })] : [];
      for (const f of fs) {
        const refs = refsOf(f.evidence);
        out.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 60 },
            children: [
              new TextRun({ text: `${KIND_LABELS[f.kind]} — `, font: FONT, size: 19, bold: true, color: f.kind === "vigilance" ? "A12A29" : f.kind === "atout" ? "0B6B47" : "1C5CAB" }),
              new TextRun({ text: f.text, font: FONT, size: 19 }),
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
              children: [new TextRun({ text: i.text, font: FONT, size: 19 }), ...(i.url ? [new TextRun({ text: " — ", font: FONT, size: 19 }), new ExternalHyperlink({ link: i.url, children: [new TextRun({ text: i.url, style: "Hyperlink", font: FONT, size: 17 })] })] : [])],
            }),
        ),
      ];
  }
}

export async function reportToDocx(r: Report): Promise<Buffer> {
  const cit = new Citations();
  const body: (Paragraph | Table | TableOfContents)[] = [];
  for (const s of r.sections) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun({ text: `${s.letter}. ${s.title}`, font: FONT })] }));
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

  const scopeLabel = { commune: "Commune", epci: "Intercommunalité", departement: "Département", custom: "Territoire personnalisé" }[r.query.scope];
  const cover = [
    new Paragraph({ spacing: { before: 1800 }, children: [new TextRun({ text: "DIAGNOSTIC TERRITORIAL", font: FONT, size: 22, color: "52514E" })] }),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: r.commune.nom, font: FONT, size: 64, bold: true, color: BLUE })] }),
    p(`${r.commune.departement.nom} (${r.commune.departement.code}) · ${r.commune.region.nom}${r.commune.epci ? ` · ${r.commune.epci.nom}` : ""}`, { size: 26, color: "52514E" }),
    p(`Périmètre d'analyse : ${scopeLabel} — ${r.perimeter.label}`, { size: 22 }),
    ...r.warnings.map((w) => p(w, { italics: true, color: "8A5300", size: 19 })),
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
