/**
 * Génération en ligne de commande.
 *
 *   npm run generate -- 60200                 # code postal (1 commune) ou code INSEE
 *   npm run generate -- 60350 --commune 60509 # code postal ambigu : choix de la commune
 *   npm run generate -- 60159 --scope epci --out demo
 *
 * Produit : <out>/<id>.json, .pdf, .docx, -indicateurs.csv, -series.csv
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { searchCommunes } from "../src/lib/collectors/admin";
import { buildReport } from "../src/lib/report/build";
import { saveReport } from "../src/lib/report/store";
import { reportToPdf } from "../src/lib/export/pdf";
import { reportToDocx } from "../src/lib/export/docx";
import { indicatorsCsv, seriesCsv } from "../src/lib/export/csv";
import { renderReportHtml } from "../src/lib/render/html";
import type { Scope } from "../src/lib/types";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const query = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

async function main() {
  if (!query) throw new Error("Usage : npm run generate -- <code postal | code INSEE | nom> [--commune CODE] [--scope commune|epci|departement] [--out DIR]");
  const cands = searchCommunes(query);
  if (!cands.length) throw new Error(`Aucune commune trouvée pour « ${query} »`);
  const chosen = opt("commune") ? cands.find((c) => c.code === opt("commune")) : cands.length === 1 || /^\d[\dAB]\d{3}$/i.test(query) && !/^\d{5}$/.test(query) ? cands[0] : null;
  if (!chosen) {
    console.log(`Plusieurs communes correspondent à « ${query} » :`);
    for (const c of cands) console.log(`  ${c.code}  ${c.nom} (${c.departementNom}, ${c.population ?? "?"} hab.)`);
    console.log("Relancez avec --commune <code INSEE>.");
    process.exit(2);
  }
  const scope = (opt("scope") ?? "commune") as Scope;
  const out = path.resolve(opt("out") ?? "exports");
  console.log(`→ ${chosen.nom} (${chosen.code}), périmètre : ${scope}`);
  const t0 = Date.now();
  const r = await buildReport({ codeInsee: chosen.code, codePostal: /^\d{5}$/.test(query) ? query : undefined, scope }, (e) =>
    console.log(`  [${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s] ${e.label}`),
  );
  await saveReport(r);
  await fs.mkdir(out, { recursive: true });
  const base = path.join(out, r.id);
  await fs.writeFile(base + ".json", JSON.stringify(r, null, 1));
  await fs.writeFile(base + ".html", renderReportHtml(r));
  await fs.writeFile(base + "-indicateurs.csv", indicatorsCsv(r));
  await fs.writeFile(base + "-series.csv", seriesCsv(r));
  await fs.writeFile(base + ".docx", await reportToDocx(r));
  try {
    await fs.writeFile(base + ".pdf", await reportToPdf(r));
  } catch (e) {
    console.warn("PDF non généré :", e instanceof Error ? e.message : e);
  }
  const failed = r.runs.filter((x) => x.status === "failed");
  console.log(`✓ ${r.indicators.length} indicateurs, ${r.tables.length} tableaux, ${r.charts.length} graphiques, ${r.maps.length} cartes, ${r.findings.length} constats`);
  console.log(`  Étapes en échec : ${failed.length}${failed.length ? " (" + [...new Set(failed.map((f) => f.sourceId))].join(", ") + ")" : ""}`);
  console.log(`  Fichiers : ${base}.{pdf,docx,html,json} + CSV`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
