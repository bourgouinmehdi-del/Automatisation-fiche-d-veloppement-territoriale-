import * as turf from "@turf/turf";
import type { BvRow } from "../analysis/political";
import { fmtNumber } from "../format";
import type { DataTable, GeoRef, Indicator } from "../types";
import type { Collected } from "./collect";

/**
 * Non-inscription sur les listes électorales (estimation).
 *
 * Écart entre les adultes de nationalité française recensés (INSEE, IRIS) et
 * les électeurs inscrits (européennes 2024). Cet écart regroupe les personnes
 * non inscrites et celles inscrites dans une autre commune (étudiants,
 * déménagements récents) : c'est un ordre de grandeur, pas un décompte.
 *
 * Par bureau de vote, la population adulte de chaque IRIS est répartie entre
 * les bureaux au prorata des adresses (Base adresse nationale), chaque
 * logement social comptant comme une adresse supplémentaire (un immeuble
 * HLM a une seule adresse pour des dizaines de foyers).
 */

export interface InscriptionOutput {
  indicators: Indicator[];
  tables: DataTable[];
  /** Phrase de la fiche (langage courant). */
  ficheText: string | null;
  /** Bureaux où l'écart estimé est le plus fort (campagne d'inscription). */
  bureaux: { bv: string; ecart: number; taux: number }[];
  commune: { adultesFr: number; inscrits: number; ecart: number; taux: number } | null;
  departement: { taux: number } | null;
}

const pct = (v: number) => `${Math.round(v)} %`;

export function buildInscription(c: Collected, ranked: BvRow[], dv: (bv: string) => string, inscritsCom: number | null, inscritsDep: number | null): InscriptionOutput {
  const out: InscriptionOutput = { indicators: [], tables: [], ficheText: null, bureaux: [], commune: null, departement: null };
  const a = c.adultes;
  if (!a?.rows.length || !inscritsCom) return out;
  // Territoire de plusieurs communes : toutes ses communes.
  const codes = new Set(c.query.scope === "custom" ? c.perimeter.communes.map((x) => x.code) : [c.commune.code]);
  const comRows = a.rows.filter((r) => codes.has(r.com));
  const comFr = comRows.reduce((s, r) => s + r.adultesFr, 0);
  if (comFr < 50) return out;
  const depFr = a.rows.reduce((s, r) => s + r.adultesFr, 0);
  const ecart = comFr - inscritsCom;
  const taux = (100 * inscritsCom) / comFr;
  out.commune = { adultesFr: comFr, inscrits: inscritsCom, ecart, taux };
  // Taux départemental incohérent (fichier partiel, plus d'inscrits que d'adultes) : pas de comparaison.
  if (inscritsDep && depFr && inscritsDep < depFr && inscritsDep > 0.5 * depFr) out.departement = { taux: (100 * inscritsDep) / depFr };
  const src = a.source;
  const year = a.annee ?? undefined;
  const ind = (id: string, label: string, g: GeoRef, value: number, unit: Indicator["unit"]) => out.indicators.push({ id, label, theme: "strategie", value, unit, year, geo: g, source: src, status: "ok", method: "Inscrits aux européennes 2024 / adultes de nationalité française recensés (INSEE, IRIS) × 100. Estimation." });
  ind("taux_inscription_estime", "Taux d'inscription estimé (inscrits / adultes français)", c.geos.commune, taux, "%");
  if (out.departement) ind("taux_inscription_estime", "Taux d'inscription estimé (inscrits / adultes français)", c.geos.departement, out.departement.taux, "%");

  /* Par bureau de vote : population répartie au prorata des adresses (et des logements sociaux). */
  const polys = (c.bvGeo?.features ?? []).map((f) => ({ bv: String(f.properties?.bv), f, bb: turf.bbox(f) }));
  const adr = c.adresses?.list ?? [];
  if (polys.length >= 2 && adr.length && ranked.length >= 2) {
    const iris = (c.quartiers?.iris ?? []).filter((q) => q.geometry).map((q) => ({ code: q.code, f: turf.feature(q.geometry as GeoJSON.Polygon), bb: turf.bbox(q.geometry as GeoJSON.Polygon) }));
    const inPoly = (lon: number, lat: number, p: { f: GeoJSON.Feature; bb: number[] }) => {
      if (lon < p.bb[0] || lon > p.bb[2] || lat < p.bb[1] || lat > p.bb[3]) return false;
      try {
        return turf.booleanPointInPolygon([lon, lat], p.f as GeoJSON.Feature<GeoJSON.Polygon>);
      } catch {
        return false;
      }
    };
    // Poids des points : 1 par adresse, plus 1 par logement social.
    const pts: { lon: number; lat: number; w: number }[] = [...adr.map((x) => ({ lon: x.lon, lat: x.lat, w: 1 })), ...(c.rpls?.residences ?? []).map((r) => ({ lon: r.lon, lat: r.lat, w: r.logements }))];
    const irisFr = new Map(comRows.map((r) => [r.iris, r.adultesFr]));
    const zoneOf = (lon: number, lat: number) => (iris.length ? (iris.find((z) => inPoly(lon, lat, z))?.code ?? null) : "commune");
    const wZone = new Map<string, number>();
    const wZoneBv = new Map<string, number>();
    for (const p of pts) {
      const z = zoneOf(p.lon, p.lat);
      const bv = polys.find((x) => inPoly(p.lon, p.lat, x))?.bv;
      if (!z || !bv) continue;
      wZone.set(z, (wZone.get(z) ?? 0) + p.w);
      wZoneBv.set(`${z}|${bv}`, (wZoneBv.get(`${z}|${bv}`) ?? 0) + p.w);
    }
    const frOfZone = (z: string) => (z === "commune" ? comFr : (irisFr.get(z) ?? 0));
    const estBv = new Map<string, number>();
    for (const [k, w] of wZoneBv) {
      const [z, bv] = k.split("|");
      estBv.set(bv, (estBv.get(bv) ?? 0) + (frOfZone(z) * w) / (wZone.get(z) || 1));
    }
    // Recalage : la somme des bureaux égale le total de la commune (adresses hors IRIS, etc.).
    const sumEst = [...estBv.values()].reduce((s, v) => s + v, 0);
    const k = sumEst ? comFr / sumEst : 1;
    const rows = ranked
      .map((b) => {
        const fr = (estBv.get(b.bv) ?? 0) * k;
        return { b, fr, ecart: fr - b.inscrits, taux: fr ? (100 * b.inscrits) / fr : null };
      })
      .filter((r) => r.fr >= 200 && r.taux != null);
    if (rows.length >= 2) {
      out.bureaux = [...rows]
        .filter((r) => r.ecart > 0 && r.taux! < taux - 3)
        .sort((x, y) => x.taux! - y.taux!)
        .slice(0, 3)
        .map((r) => ({ bv: r.b.bv, ecart: r.ecart, taux: r.taux! }));
      out.tables.push({
        id: "lfi_inscription",
        title: "Inscription sur les listes électorales par bureau de vote (estimation)",
        theme: "strategie",
        columns: [
          { key: "bv", label: "Bureau" },
          { key: "inscrits", label: "Électeurs inscrits", align: "right" },
          { key: "adultes", label: "Adultes français (estimation)", align: "right" },
          { key: "taux", label: "Inscrits pour 100 adultes", align: "right" },
          { key: "ecart", label: "Écart", align: "right" },
        ],
        rows: [...rows]
          .sort((x, y) => x.taux! - y.taux!)
          .map((r) => ({ bv: dv(r.b.bv), inscrits: fmtNumber(r.b.inscrits), adultes: `~${fmtNumber(Math.round(r.fr / 10) * 10)}`, taux: fmtNumber(Math.round(r.taux!)), ecart: r.ecart > 0 ? `~${fmtNumber(Math.round(r.ecart / 10) * 10)}` : "—" })),
        highlight: rows
          .sort((x, y) => x.taux! - y.taux!)
          .map((r, i) => (out.bureaux.some((x) => x.bv === r.b.bv) ? i : -1))
          .filter((i) => i >= 0),
        sources: [src, ...(c.adresses ? [c.adresses.source] : []), ...(c.bvGeo ? [c.bvGeo.source] : [])],
        note: `Adultes de nationalité française du recensement ${a.annee ?? ""}, répartis entre les bureaux selon les adresses (et les logements sociaux) ; inscrits aux européennes 2024. L'écart regroupe les non-inscrits et les personnes inscrites ailleurs (étudiants, déménagements) : c'est un ordre de grandeur. Contours des bureaux approximatifs.${a.nationalite ? "" : " Nationalité non disponible : tous les adultes sont comptés."}`.replace("recensement  ,", "recensement,"),
      });
    }
  }

  // Phrase de la fiche : seulement si l'écart est réel et plus fort que dans le département.
  const dep = out.departement?.taux;
  if (ecart > 100 && taux < 100 && (dep == null ? taux < 92 : taux < dep - 2)) {
    const bvTxt = out.bureaux.length ? ` L'écart semble le plus fort dans ${out.bureaux.length > 1 ? "les bureaux" : "le bureau"} ${out.bureaux.map((b) => dv(b.bv)).join(", ").replace(/, ([^,]*)$/, " et $1")} : à vérifier sur le terrain avant une campagne d'inscription.` : "";
    // Ville étudiante : beaucoup de 18-24 ans restent inscrits chez leurs parents ; l'écart ne mesure pas une non-inscription.
    const adultes = comRows.reduce((s, r) => s + r.adultes, 0);
    const jeunes = comRows.every((r) => r.jeunes != null) ? comRows.reduce((s, r) => s + (r.jeunes ?? 0), 0) : null;
    const partJeunes = jeunes != null && adultes ? (100 * jeunes) / adultes : null;
    const n = fmtNumber(Math.round(ecart / 100) * 100);
    out.ficheText =
      partJeunes != null && partJeunes >= 15
        ? `**Des jeunes à inscrire sur les listes** : la commune compte beaucoup de 18-24 ans (${pct(partJeunes)} des adultes, contre 10 % environ en France), souvent étudiants et encore inscrits chez leurs parents. Environ ${n} adultes de nationalité française ne sont pas inscrits dans la commune : une campagne d'inscription vise d'abord les résidences étudiantes et les jeunes qui viennent de s'installer.${bvTxt}`
        : `**Des habitants absents des listes électorales** : environ ${n} adultes de nationalité française ne sont pas inscrits dans la commune (${pct(100 - taux)} des adultes${dep != null ? `, contre ${pct(100 - dep)} dans le département` : ""}), qu'ils ne soient inscrits nulle part ou ailleurs.${bvTxt}`;
  }
  return out;
}
