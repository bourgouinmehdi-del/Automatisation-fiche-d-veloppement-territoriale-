import type { DataTable, Report } from "../types";

/** Échappement CSV (séparateur « ; », usage courant dans les tableurs français). */
const cell = (v: unknown) => {
  if (v == null) return "";
  const s = typeof v === "number" ? String(v).replace(".", ",") : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (arr: unknown[]) => arr.map(cell).join(";");

/** Tous les indicateurs, au format long, avec leur traçabilité complète. */
export function indicatorsCsv(r: Report): string {
  const head = ["indicateur", "libelle", "theme", "niveau", "code_geo", "territoire", "valeur", "unite", "millesime", "statut", "numerateur", "denominateur", "source", "jeu_de_donnees", "url", "date_recuperation", "methode", "limites"];
  const rows = r.indicators.map((i) => [i.id, i.label, i.theme, i.geo.level, i.geo.code, i.geo.name, i.value, i.unit, i.year, i.status, i.numerator, i.denominator, i.source.name, i.source.dataset, i.source.url, i.source.retrievedAt, i.method, i.limits]);
  return "\ufeff" + [line(head), ...rows.map(line)].join("\r\n");
}

export function tableCsv(t: DataTable): string {
  return "\ufeff" + [line(t.columns.map((c) => c.label)), ...t.rows.map((r) => line(t.columns.map((c) => r[c.key])))].join("\r\n");
}

export function seriesCsv(r: Report): string {
  const head = ["serie", "libelle", "niveau", "code_geo", "territoire", "x", "valeur", "unite", "source", "url"];
  const rows = r.series.flatMap((s) => s.points.map((p) => [s.id, s.label, s.geo.level, s.geo.code, s.geo.name, p.x, p.y, s.unit, s.source.name, s.source.url]));
  return "\ufeff" + [line(head), ...rows.map(line)].join("\r\n");
}
