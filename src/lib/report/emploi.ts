import { fmtNumber } from "../format";
import type { StmtPoint } from "../collectors/emploi";
import type { ChartSpec, DataTable, Finding, GeoRef, Indicator } from "../types";
import type { Collected } from "./collect";

/**
 * Demandeurs d'emploi inscrits à France Travail (fichiers déposés) : chiffres
 * du dernier mois, évolution sur un an, profil (femmes, âge, ancienneté
 * d'inscription), comparés au département et à la France.
 *
 * Rupture de série en janvier 2025 : la loi « pour le plein emploi » inscrit
 * automatiquement à France Travail les allocataires du RSA et les jeunes suivis
 * par les missions locales. Les comparaisons qui enjambent cette date sont
 * signalées.
 */

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export const moisFr = (m: string) => `${MOIS[Number(m.slice(4)) - 1]} ${m.slice(0, 4)}`;
const moisCourt = (m: string) => `${m.slice(4)}/${m.slice(0, 4)}`;
const minus12 = (m: string) => `${Number(m.slice(0, 4)) - 1}${m.slice(4)}`;
const pp = (v: number | null | undefined, signed = false) => (v == null || !Number.isFinite(v) ? "n.d." : `${signed && v > 0 ? "+" : v < 0 ? "−" : ""}${fmtNumber(Math.abs(Math.round(v)))} %`);

/** « 1 an et 8 mois », « 11 mois ». */
export function duree(jours: number | null): string {
  if (jours == null) return "n.d.";
  const mois = Math.round(jours / 30.44);
  const a = Math.floor(mois / 12);
  const m = mois % 12;
  if (!a) return `${m} mois`;
  return `${a} an${a > 1 ? "s" : ""}${m ? ` et ${m} mois` : ""}`;
}

export interface EmploiOutput {
  indicators: Indicator[];
  tables: DataTable[];
  charts: ChartSpec[];
  findings: Finding[];
  /** Phrase en langage courant pour la fiche d'action. */
  ficheText: string | null;
}

interface Snap {
  last: StmtPoint;
  prev: StmtPoint | null;
  evol: number | null;
}

function snap(xs: StmtPoint[], mois: string): Snap | null {
  const last = xs.find((p) => p.mois === mois);
  if (!last) return null;
  const prev = xs.find((p) => p.mois === minus12(mois)) ?? null;
  return { last, prev, evol: prev && prev.n ? (100 * (last.n - prev.n)) / prev.n : null };
}

export function buildEmploi(c: Collected): EmploiOutput {
  const out: EmploiOutput = { indicators: [], tables: [], charts: [], findings: [], ficheText: null };
  const e = c.emploi;
  if (!e?.commune.length) return out;
  const src = e.source;
  const mois = e.commune[e.commune.length - 1].mois;
  const com = snap(e.commune, mois);
  const dep = snap(e.departement, mois);
  const fr = snap(e.france, mois);
  if (!com) return out;
  const { geos } = c;
  const year = mois.slice(0, 4);
  const geoRows: [GeoRef, Snap | null][] = [
    [geos.commune, com],
    [geos.departement, dep],
    [geos.france, fr],
  ];
  const ind = (id: string, label: string, g: GeoRef, value: number | null, unit: Indicator["unit"], method: string) =>
    value != null && Number.isFinite(value) && out.indicators.push({ id, label, theme: "emploi", value, unit, year, geo: g, source: src, status: "ok", method });
  for (const [g, s] of geoRows) {
    if (!s) continue;
    ind("de_nombre", `Demandeurs d'emploi inscrits (${moisFr(mois)})`, g, s.last.n, "nombre", "Demandeurs d'emploi inscrits à France Travail en fin de mois, par commune de résidence.");
    ind("de_evol_1an", "Évolution du nombre de demandeurs d'emploi sur un an", g, s.evol, "%", "Variation entre le même mois de l'année précédente et le dernier mois disponible.");
    ind("de_part_femmes", "Part de femmes parmi les demandeurs d'emploi", g, s.last.fem != null ? 100 * s.last.fem : null, "%", "Moyenne pondérée par les effectifs (communes soumises au secret exclues).");
    ind("de_age_moyen", "Âge moyen des demandeurs d'emploi", g, s.last.age, "nombre", "Moyenne pondérée par les effectifs.");
    ind("de_anciennete_mois", "Ancienneté moyenne d'inscription (mois)", g, s.last.anc != null ? s.last.anc / 30.44 : null, "nombre", "Ancienneté moyenne d'inscription, en jours, convertie en mois.");
  }
  const rupture = minus12(mois) < "202501" && mois >= "202501";
  const noteRupture =
    "Depuis janvier 2025 (loi « pour le plein emploi »), les allocataires du RSA et les jeunes suivis par une mission locale sont inscrits automatiquement à France Travail : le nombre de demandeurs d'emploi a augmenté mécaniquement à cette date.";

  out.tables.push({
    id: "table_demandeurs",
    title: `Demandeurs d'emploi inscrits à France Travail, fin ${moisFr(mois)}`,
    theme: "emploi",
    columns: [
      { key: "territoire", label: "", wide: true },
      { key: "n", label: "Demandeurs d'emploi", align: "right" },
      { key: "evol", label: "Évolution sur un an", align: "right" },
      { key: "fem", label: "Femmes", align: "right" },
      { key: "age", label: "Âge moyen", align: "right" },
      { key: "anc", label: "Inscrits depuis (en moyenne)", align: "right" },
    ],
    rows: geoRows
      .filter(([, s]) => s)
      .map(([g, s]) => ({
        territoire: g.level === "france" ? "France" : g.name,
        n: fmtNumber(s!.last.n),
        evol: pp(s!.evol, true),
        fem: s!.last.fem != null ? pp(100 * s!.last.fem) : "n.d.",
        age: s!.last.age != null ? `${fmtNumber(Math.round(s!.last.age))} ans` : "n.d.",
        anc: duree(s!.last.anc),
      })),
    highlight: [0],
    sources: [src],
    note: `Demandeurs d'emploi inscrits en fin de mois, toutes catégories du fichier fourni, par commune de résidence.${rupture ? ` ${noteRupture}` : ""}`,
  });

  // Évolution depuis le début de la série, en base 100 (commune, département, France).
  const base = e.commune[0].mois;
  const idx = (xs: StmtPoint[]) => {
    const b = xs.find((p) => p.mois === base)?.n;
    return new Map(xs.map((p) => [p.mois, b ? Math.round((1000 * p.n) / b) / 10 : null]));
  };
  const ic = idx(e.commune);
  const id = idx(e.departement);
  const ifr = idx(e.france);
  out.charts.push({
    id: "chart_demandeurs",
    title: `Évolution du nombre de demandeurs d'emploi (base 100 en ${moisFr(base)})`,
    type: "line",
    xKey: "mois",
    data: e.commune.map((p) => ({ mois: moisCourt(p.mois), commune: ic.get(p.mois) ?? null, dep: id.get(p.mois) ?? null, ...(e.france.length ? { fr: ifr.get(p.mois) ?? null } : {}) })),
    series: [
      { key: "commune", label: c.commune.nom },
      { key: "dep", label: geos.departement.name },
      ...(e.france.length ? [{ key: "fr", label: "France" }] : []),
    ],
    unit: "nombre",
    sources: [src],
    note: `Indice 100 = nombre de demandeurs d'emploi en ${moisFr(base)}. ${noteRupture}`,
  });
  out.charts.push({
    id: "chart_demandeurs_nombre",
    title: `Demandeurs d'emploi résidant à ${c.commune.nom}, fin de mois`,
    type: "line",
    xKey: "mois",
    data: e.commune.map((p) => ({ mois: moisCourt(p.mois), n: p.n })),
    series: [{ key: "n", label: "Demandeurs d'emploi" }],
    unit: "nombre",
    sources: [src],
    note: noteRupture,
  });

  // Phrase de la fiche, en langage courant.
  const parts: string[] = [];
  const word = (v: number) => (Math.abs(v) < 2 ? "stable" : v > 0 ? `en hausse de ${pp(v)}` : `en baisse de ${pp(Math.abs(v))}`);
  let head = `**${fmtNumber(com.last.n)} demandeurs d'emploi** fin ${moisFr(mois)}`;
  if (com.evol != null) head += `, un nombre ${word(com.evol)} en un an${dep?.evol != null ? ` (département : ${Math.abs(dep.evol) < 2 ? "stable" : pp(dep.evol, true)})` : ""}`;
  parts.push(head + ".");
  if (com.last.anc != null && dep?.last.anc != null) {
    const r = com.last.anc / dep.last.anc;
    parts.push(`Ils sont inscrits depuis ${duree(com.last.anc)} en moyenne, ${r > 1.1 ? "plus longtemps qu'ailleurs dans le département" : r < 0.9 ? "moins longtemps qu'ailleurs dans le département" : "comme ailleurs dans le département"}.`);
  }
  out.ficheText = parts.join(" ");
  out.findings.push({
    id: "E1",
    kind: com.evol != null && dep?.evol != null && com.evol > dep.evol + 3 ? "vigilance" : "constat",
    theme: "emploi",
    weight: 70,
    evidence: out.indicators.filter((i) => i.id === "de_nombre" || i.id === "de_evol_1an").map((i) => `${i.id}@${i.geo.level}:${i.geo.code}`),
    text: `${out.ficheText}${rupture ? ` ${noteRupture}` : ""}`,
  });
  return out;
}
