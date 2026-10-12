import { Resvg } from "@resvg/resvg-js";
import { getReport } from "@/lib/report/store";
import { indicatorsCsv, seriesCsv, tableCsv } from "@/lib/export/csv";
import { reportToDocx } from "@/lib/export/docx";
import { reportToPdf } from "@/lib/export/pdf";
import { renderReportHtml } from "@/lib/render/html";
import { mapSvg } from "@/lib/render/svg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exports : pdf | docx | html | json | csv (indicateurs) | series (CSV)
 *           table (CSV, ?id=) | geojson (?id= carte) | map-svg | map-png (?id=)
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; format: string }> }) {
  const { id, format } = await params;
  const r = await getReport(id);
  if (!r) return new Response("Rapport introuvable", { status: 404 });
  const q = new URL(req.url).searchParams;
  const sub = q.get("id") ?? "";
  const style = q.get("style") === "yonne" ? "yonne" : "moderne";
  const ciblage = r.sections.some((s) => s.id === "CIBLAGE");
  const ficheIds = [ciblage ? "CIBLAGE" : "LFI"];
  const ficheName = (ext: string) => `${name}-${ciblage ? "ciblage" : "fiche-action"}${style === "yonne" ? "-yonne" : ""}.${ext}`;
  const name = `diagnostic-${r.commune.nom.normalize("NFD").replace(/[^\w]+/g, "-").toLowerCase()}-${r.commune.code}`;
  const file = (body: BodyInit, type: string, filename: string, inline = false) =>
    new Response(body, { headers: { "Content-Type": type, "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"` } });
  switch (format) {
    case "pdf":
      try {
        // ?fiche=1 : fiche d'action seule (quelques pages, comme le document de référence).
        if (q.get("fiche")) return file(new Uint8Array(await reportToPdf(r, { sectionIds: ficheIds, style })), "application/pdf", ficheName("pdf"));
        // ?porte=1 : feuilles de porte-à-porte seules (une page par bureau prioritaire).
        if (q.get("porte")) {
          if (!r.sections.some((s) => s.id === "PORTE")) return new Response("Pas de feuilles de porte-à-porte pour cette fiche (contours des bureaux ou adresses indisponibles).", { status: 404 });
          return file(new Uint8Array(await reportToPdf(r, { sectionIds: ["PORTE"] })), "application/pdf", `${name}-porte-a-porte.pdf`);
        }
        return file(new Uint8Array(await reportToPdf(r)), "application/pdf", `${name}.pdf`);
      } catch (e) {
        return new Response(`Export PDF impossible : ${e instanceof Error ? e.message : e}. Renseignez CHROMIUM_PATH.`, { status: 500 });
      }
    case "docx":
      // ?fiche=1 : fiche seule, au format Word du document de référence (modifiable).
      if (q.get("fiche")) return file(new Uint8Array(await reportToDocx(r, { sectionIds: ficheIds, style: "yonne" })), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ficheName("docx").replace("-yonne", ""));
      return file(new Uint8Array(await reportToDocx(r)), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `${name}.docx`);
    case "html":
      if (q.get("fiche")) return file(renderReportHtml(r, { sectionIds: ficheIds, style }), "text/html; charset=utf-8", ficheName("html"), true);
      return file(renderReportHtml(r), "text/html; charset=utf-8", `${name}.html`, true);
    case "json":
      return file(JSON.stringify(r, null, 1), "application/json", `${name}.json`);
    case "csv":
      return file(indicatorsCsv(r), "text/csv; charset=utf-8", `${name}-indicateurs.csv`);
    case "series":
      return file(seriesCsv(r), "text/csv; charset=utf-8", `${name}-series.csv`);
    case "table": {
      const t = r.tables.find((x) => x.id === sub);
      return t ? file(tableCsv(t), "text/csv; charset=utf-8", `${name}-${t.id}.csv`) : new Response("Tableau introuvable", { status: 404 });
    }
    case "geojson": {
      const m = r.maps.find((x) => x.id === sub);
      if (!m) return new Response("Carte introuvable", { status: 404 });
      const fc = { type: "FeatureCollection", features: m.layers.flatMap((l) => l.data.features.map((f) => ({ ...f, properties: { ...f.properties, couche: l.label } }))) };
      return file(JSON.stringify(fc), "application/geo+json", `${name}-${m.id}.geojson`);
    }
    case "map-svg":
    case "map-png": {
      const m = r.maps.find((x) => x.id === sub);
      if (!m) return new Response("Carte introuvable", { status: 404 });
      const svg = mapSvg(m, 1000, 760);
      if (format === "map-svg") return file(svg, "image/svg+xml", `${name}-${m.id}.svg`);
      const png = new Resvg(svg, { fitTo: { mode: "width", value: 2000 }, font: { loadSystemFonts: true }, background: "#ffffff" }).render().asPng();
      return file(new Uint8Array(png), "image/png", `${name}-${m.id}.png`);
    }
    default:
      return new Response("Format inconnu", { status: 400 });
  }
}
