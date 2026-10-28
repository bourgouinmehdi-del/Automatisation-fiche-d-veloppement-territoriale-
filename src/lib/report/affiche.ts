import * as turf from "@turf/turf";
import type { BvRow } from "../analysis/political";
import { quartierLabel } from "../analysis/quartiers";
import { fmtNumber } from "../format";
import { POSTER } from "../render/poster";
import type { MapLayer, MapSpec, SourceRef } from "../types";
import type { Collected } from "./collect";

/**
 * Carte « affiche » d'une commune : propositions de porte-à-porte (quartiers
 * prioritaires, bureaux de vote prioritaires, résidences étudiantes) et de
 * tractage (marchés, gares), sur un fond de plan OpenStreetMap.
 */

interface Lieu {
  nom: string;
  infos: string;
  lon: number | null;
  lat: number | null;
}

const ROAD: Record<number, [number, string]> = {
  1: [2.8, "#bfb5a3"],
  2: [2.1, "#c8bfae"],
  3: [1.6, "#cfc7b7"],
  4: [1.15, "#d6cebf"],
  5: [0.6, "#ddd6c9"],
};

/** « ~10 000 voyageurs par jour » à partir d'une fréquentation annuelle. */
export function perDay(voyageursAn: number): string {
  const d = voyageursAn / 365;
  const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(d)) - 1));
  return `~${fmtNumber(Math.round(d / mag) * mag)} voyageurs/jour`;
}

/** « Gare d'Ivry-sur-Seine », « Gare de Compiègne », « Gare de Paris Austerlitz ». */
export function gareNom(nom: string): string {
  if (/^gare\b/i.test(nom)) return nom;
  return `Gare ${/^[aeiouyàâéèêëîïôûüœ]/i.test(nom) ? "d'" : "de "}${nom}`;
}

/**
 * Créneaux du week-end : les actions militantes ont lieu le samedi et le dimanche
 * (pas de sorties d'école, collège ou lycée ; services publics fermés, sauf la poste le samedi matin).
 */
export const WEEKEND = {
  porte: "Samedi 10 h – 12 h 30 ou 17 h – 19 h ; dimanche 10 h 30 – 12 h 30",
  foyer: "Samedi ou dimanche, 17 h – 19 h",
  crous: "Dimanche 18 h – 20 h (retour des étudiants) ou samedi 11 h – 13 h, hors vacances universitaires",
  gare: "Samedi 9 h – 12 h ; dimanche 17 h – 20 h (retours de week-end)",
  station: "Samedi 10 h – 13 h ou 16 h – 19 h ; dimanche 10 h – 12 h",
  marche: "Matinée du marché, samedi ou dimanche (jour à confirmer en mairie)",
  poste: "Samedi 9 h – 12 h, si le bureau est ouvert",
  supermarche: "Samedi 10 h – 12 h ou dimanche matin",
};

/**
 * Horaires réduits au week-end : « mercredi, samedi et dimanche, 8 h – 13 h » → « samedi et dimanche,
 * 8 h – 13 h » ; « vendredi, 12 h – 21 h ; dimanche, 8 h – 14 h » → « dimanche, 8 h – 14 h ».
 * Chaîne vide si aucun créneau du week-end n'est connu.
 */
export function weekendHours(h: string): string {
  const JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
  const out: string[] = [];
  for (const part of h.split(/\s*;\s*/)) {
    const m = part.match(/^(.*?),\s*(\d.*)$/);
    if (!m) continue;
    const [, days, hours] = m;
    let we: string[] = [];
    if (/tous les jours/i.test(days)) we = ["samedi", "dimanche"];
    else {
      for (const r of days.matchAll(/du (\w+) au (\w+)/gi)) {
        const a = JOURS.indexOf(r[1].toLowerCase());
        const b = JOURS.indexOf(r[2].toLowerCase());
        if (a >= 0 && b >= a) we.push(...JOURS.slice(Math.max(a, 5), b + 1));
      }
      for (const d of days.replace(/du \w+ au \w+/gi, "").split(/,|\bet\b/)) {
        const j = d.trim().toLowerCase();
        if (j === "samedi" || j === "dimanche") we.push(j);
      }
    }
    we = [...new Set(we)].sort((x, y) => JOURS.indexOf(x) - JOURS.indexOf(y));
    if (we.length) out.push(`${we.join(" et ")}, ${hours}`);
  }
  return out.join(" ; ");
}

/** Horaires (« du mardi au samedi, 8 h – 13 h ») : ouvert le week-end ? null si inconnu. */
export function openWeekend(h: string): boolean | null {
  if (/samedi|dimanche|tous les jours|\b(sam|dim)\.|\b(Sa|Su)\b/i.test(h)) return true;
  // Jours de semaine seulement (« jeudi, 8 h – 13 h », « Jul-Aug jeu. 08:00-13:00 ») : pas un marché du week-end.
  if (/lundi|mardi|mercredi|jeudi|vendredi|\b(lun|mar|mer|jeu|ven)\.|\b(Mo|Tu|We|Th|Fr)\b/i.test(h) && /\d/.test(h)) return false;
  return null;
}

/** Fréquentation minimale d'une gare de tractage (voyageurs par jour). */
export const GARE_MIN_JOUR = 300;

/** Vert du moment convivial. */
export const CONVIVIAL_GREEN = "#2f8f4e";

/** Rond rouge des résidences Crous et foyers de jeunes travailleurs. */
export const RESIDENCE_RED = "#F91616";

export interface PosterLieu extends Lieu {
  /** Créneau conseillé (« Samedi 10 h – 12 h 30 »). */
  quand?: string;
  type?: string;
}

/** Rue de logements sociaux (RPLS) rattachée à un bureau de vote. */
export interface PosterRue {
  voie: string;
  nums: string[];
  logements: number;
  lon: number;
  lat: number;
  noms: string[];
  bv: string | null;
}

const numsTxt = (nums: string[]) => (!nums.length ? "" : nums.length === 1 ? `n° ${nums[0]}` : nums.length > 4 ? `n° ${nums[0]} à ${nums[nums.length - 1]}` : `n° ${nums.slice(0, -1).join(", ")} et ${nums[nums.length - 1]}`);

export function communePoster(
  c: Collected,
  o: {
    prio: BvRow[];
    labels: Map<string, string>;
    markets: PosterLieu[];
    gares: (PosterLieu & { voyageurs?: number | null })[];
    /** Stations de métro, RER, tram. */
    stations?: PosterLieu[];
    /** Grandes surfaces retenues (grands groupes, desservies). */
    supermarches?: PosterLieu[];
    /** Lieu du moment convivial (parc, bar). */
    convivial?: (PosterLieu & { kind: "parc" | "bar" })[];
    ecoles?: PosterLieu[];
    rues?: PosterRue[];
    hlmByBv?: Map<string, number>;
    dv?: (bv: string) => string;
    quandPorte?: string;
  },
): MapSpec | null {
  const { commune } = c;
  if (!commune.contour) return null;
  const dv = o.dv ?? String;
  const contour = turf.feature(commune.contour as GeoJSON.Polygon, { nom: commune.nom });
  const qpv = (c.quartiers?.qpv ?? []).filter((q) => q.geometry);
  const allBv = (c.bvGeo?.features ?? []).filter((f) => f.geometry);
  const prioSet = new Set(o.prio.map((p) => p.bv));
  const prioPolys = allBv.filter((f) => prioSet.has(String(f.properties?.bv)));
  // Résidences du Crous et foyers de jeunes travailleurs (porte-à-porte systématique), six au plus.
  const res = (c.residences?.list ?? [])
    .filter((r) => r.porte)
    .sort((a, b) => (b.logements ?? 0) - (a.logements ?? 0))
    .slice(0, 6);
  const pts = <T extends Lieu>(xs: T[]) => xs.filter((x) => x.lon != null && x.lat != null);
  const markets = pts(o.markets).slice(0, 3);
  const gares = pts(o.gares).slice(0, 2);
  const ecoles = pts(o.ecoles ?? []).slice(0, 3);
  // Logements sociaux rue par rue : d'abord ceux des bureaux prioritaires (cinq au plus), puis les grandes rues ailleurs.
  const rues = (o.rues ?? []).filter((r) => r.logements >= 20);
  const ruesPrio = rues.filter((r) => r.bv && prioSet.has(r.bv)).slice(0, 5);
  const ruesAutres = rues.filter((r) => !ruesPrio.includes(r) && r.logements >= 100).slice(0, Math.max(2, 6 - ruesPrio.length));
  const ruesNum = [...ruesPrio, ...ruesAutres];
  const ruesDots = rues.filter((r) => !ruesNum.includes(r));
  if (!qpv.length && !prioPolys.length && !res.length && !markets.length && !gares.length && !ruesNum.length) return null;
  const bbox = c.fond?.bbox ?? (turf.bbox(contour) as [number, number, number, number]);
  const inBox = (lon: number, lat: number) => lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
  const geoSrc: SourceRef = c.geoSource ?? { id: "geoapi", name: "geo.api.gouv.fr", url: "https://geo.api.gouv.fr", retrievedAt: new Date().toISOString() };
  const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
  const layers: MapLayer[] = [];

  // Communes voisines (grisées, nom en capitales) ; une « commune » qui contient la nôtre (Paris pour un arrondissement) est écartée.
  const centre = turf.pointOnFeature(contour);
  const box = turf.bboxPolygon(bbox);
  const voisins = (c.depFeatures?.features ?? []).filter((f) => {
    const p = f.properties as { code: string };
    if (!f.geometry || p.code === commune.code) return false;
    try {
      if (!turf.booleanIntersects(f, box)) return false;
      return !turf.booleanPointInPolygon(centre, f as GeoJSON.Feature<GeoJSON.Polygon>);
    } catch {
      return false;
    }
  });
  const capsAt = (f: GeoJSON.Feature) => {
    // Nom placé dans la partie visible de la commune voisine, hors de notre commune (les contours
    // simplifiés du département peuvent la chevaucher : Dunkerque s'affichait sur Grande-Synthe),
    // au point le plus éloigné à la fois de la commune et du bord de la carte.
    try {
      const clip = turf.bboxClip(f as GeoJSON.Feature<GeoJSON.Polygon>, bbox);
      const [x0, y0, x1, y1] = turf.bbox(clip);
      const N = 14;
      let best: { at: number[]; score: number } | null = null;
      for (let i = 0; i <= N; i++)
        for (let j = 0; j <= N; j++) {
          const pt = turf.point([x0 + ((x1 - x0) * i) / N, y0 + ((y1 - y0) * j) / N]);
          if (!turf.booleanPointInPolygon(pt, clip as GeoJSON.Feature<GeoJSON.Polygon>)) continue;
          if (turf.booleanPointInPolygon(pt, contour as GeoJSON.Feature<GeoJSON.Polygon>)) continue;
          const dC = turf.pointToPolygonDistance(pt, contour as GeoJSON.Feature<GeoJSON.Polygon>, { units: "kilometers" });
          const [px, py] = pt.geometry.coordinates;
          const dB = Math.min(px - bbox[0], bbox[2] - px, (py - bbox[1]) * 1.5, (bbox[3] - py) * 1.5) * 70;
          const score = Math.min(dC, dB);
          if (!best || score > best.score) best = { at: pt.geometry.coordinates, score };
        }
      return best?.at ?? turf.pointOnFeature(clip).geometry.coordinates;
    } catch {
      return undefined;
    }
  };
  if (voisins.length)
    layers.push({
      id: "voisins",
      label: "Communes voisines",
      kind: "polygons",
      data: fc(voisins.map((f) => ({ type: "Feature", geometry: f.geometry, properties: { nom: (f.properties as { nom: string }).nom, _at: capsAt(f) } }))),
      style: { fill: POSTER.hors, stroke: "#b9b2a4", strokeWidth: 0.8 },
      labelMode: "caps",
      labelProperty: "nom",
      visible: true,
      source: geoSrc,
    });
  layers.push({ id: "commune", label: commune.nom, kind: "polygons", data: fc([{ ...contour, properties: { nom: commune.nom, _at: centre.geometry.coordinates } }]), style: { fill: POSTER.creme, stroke: "none" }, labelMode: "caps", labelProperty: "nom", visible: true, source: geoSrc });
  // Fond jaune pâle des bureaux prioritaires, sous les rues (le plan reste lisible).
  if (prioPolys.length) layers.push({ id: "bv_prio_fond", label: "Bureaux prioritaires (fond)", kind: "polygons", data: fc(prioPolys.map((p) => ({ type: "Feature", geometry: p.geometry, properties: {} }))), style: { fill: "#fbe8b4", stroke: "none" }, visible: true, source: c.bvGeo!.source });

  const f = c.fond;
  // Rues à nommer : grands axes et rues où se trouvent les logements sociaux numérotés.
  const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const ruesNoms = new Set(ruesNum.map((r) => norm(r.voie)));
  if (f) {
    if (f.water.length) layers.push({ id: "eau", label: "Cours d'eau", kind: "polygons", data: fc(f.water), style: { fill: "#cfe0ea", stroke: "none" }, legendItem: { label: "Cours d'eau", swatch: "fill" }, visible: true, source: f.source });
    if (f.waterLines.length) layers.push({ id: "rivieres", label: "Rivières", kind: "lines", data: fc(f.waterLines), style: { fill: "#cfe0ea", stroke: "#bcd5e4", strokeWidth: 3 }, ...(f.water.length ? {} : { legendItem: { label: "Cours d'eau", swatch: "line" as const } }), visible: true, source: f.source });
    layers.push({
      id: "voies",
      label: "Voies",
      kind: "lines",
      data: fc(
        [...f.roads]
          .sort((a, b) => (b.properties?.c ?? 5) - (a.properties?.c ?? 5))
          .map((r) => {
            const cl = (r.properties?.c ?? 5) as number;
            const n = r.properties?.n as string | undefined;
            const named = !!n && (cl <= 3 || ruesNoms.has(norm(n)));
            return { ...r, properties: { _sw: ROAD[cl][0], _stroke: ROAD[cl][1], ...(named ? { n, _rank: ruesNoms.has(norm(n!)) ? 0 : cl } : {}) } };
          }),
      ),
      labelMode: "road",
      labelProperty: "n",
      visible: true,
      source: f.source,
    });
    if (f.rail.length) layers.push({ id: "fer", label: "Voie ferrée", kind: "lines", data: fc(f.rail), style: { stroke: "#77736a", strokeWidth: 1.2, dash: "7 4" }, legendItem: { label: "Voie ferrée", swatch: "dash" }, visible: true, source: f.source });
  }
  // Tous les bureaux de vote, en contour fin avec leur numéro (repère pour les militants).
  if (allBv.length >= 2)
    layers.push({
      id: "bv_ctx",
      label: "Bureaux de vote",
      kind: "polygons",
      data: fc(allBv.map((p) => ({ type: "Feature", geometry: p.geometry, properties: { num: `BV ${dv(String(p.properties?.bv))}`, nom: `Bureau ${dv(String(p.properties?.bv))}${o.labels.has(String(p.properties?.bv)) ? ` — ${o.labels.get(String(p.properties?.bv))}` : ""}` } }))),
      style: { fill: "none", stroke: "#a39a88", strokeWidth: 0.7, dash: "2 2" },
      labelMode: allBv.length <= 80 ? "tag" : undefined,
      labelProperty: "num",
      labelColor: "#8a8170",
      legendItem: { label: "Limite de bureau de vote (numéro)", swatch: "dash" },
      visible: true,
      source: c.bvGeo!.source,
    });
  layers.push({ id: "limite", label: "Limite communale", kind: "polygons", data: fc([contour]), style: { fill: "none", stroke: POSTER.charbon, strokeWidth: 1.4, dash: "5 4" }, legendItem: { label: "Limite communale", swatch: "dash" }, visible: true, source: geoSrc });

  if (qpv.length)
    layers.push({
      id: "qpv",
      label: "Quartiers prioritaires",
      kind: "polygons",
      data: fc(qpv.map((q) => ({ type: "Feature", geometry: q.geometry!, properties: { nom: quartierLabel(q.nom).replace(/^./, (x) => x.toUpperCase()), sub: q.stats.hlm != null ? `${Math.round(q.stats.hlm)} % de logements sociaux` : "" } }))),
      style: { fill: "none", stroke: POSTER.violet, strokeWidth: 1.6, dash: "6 3" },
      labelMode: "tag",
      labelProperty: "nom",
      labelColor: POSTER.violet,
      legendItem: { label: "Quartier prioritaire de la ville", swatch: "dash" },
      visible: true,
      source: c.quartiers!.sources[0],
    });

  if (prioPolys.length) {
    const byBv = new Map(o.prio.map((p) => [p.bv, p]));
    // Pastille au lieu de vote quand il est connu (et dans le bureau), sinon au cœur du bureau.
    const place = new Map((c.bvGeo?.points ?? []).map((p) => [String(p.properties?.bv), p.geometry.coordinates as [number, number]]));
    layers.push({
      id: "bv_prio",
      label: "Bureaux de vote prioritaires",
      kind: "polygons",
      data: fc(
        prioPolys.map((p) => {
          const bv = String(p.properties?.bv);
          const r = byBv.get(bv)!;
          const at = place.get(bv);
          let inside = false;
          try {
            inside = !!at && turf.booleanPointInPolygon(at, p as GeoJSON.Feature<GeoJSON.Polygon>);
          } catch {
            inside = false;
          }
          const lieu = o.labels.get(bv);
          const nHlm = o.hlmByBv?.get(bv) ?? 0;
          const when = r.abstSrc === "LG24T1" ? " aux législatives 2024" : "";
          return {
            type: "Feature",
            geometry: p.geometry,
            properties: {
              nom: `Bureau ${dv(bv)}${lieu ? ` — ${lieu}` : ""}`,
              sub: `${fmtNumber(r.abstN)} inscrits n'ont pas voté${when} · LFI ${fmtNumber(Math.round(r.lfiPctExp))} % aux européennes`,
              det: [
                lieu ? `Lieu de vote : ${lieu}` : "",
                `${fmtNumber(r.inscrits)} inscrits, dont ${fmtNumber(r.abstN)} n'ont pas voté${when} (${fmtNumber(Math.round(r.abstPct))} %)`,
                `Vote LFI : ${fmtNumber(Math.round(r.lfiPctExp))} % aux européennes 2024${r.lfi2PctExp != null ? `, ${fmtNumber(Math.round(r.lfi2PctExp))} % pour J.-L. Mélenchon en 2022` : ""}`,
                nHlm >= 20 ? `${fmtNumber(nHlm)} logements sociaux dans le bureau` : "",
              ].filter(Boolean),
              quand: o.quandPorte ?? WEEKEND.porte,
              ...(inside ? { _at: at } : {}),
            },
          };
        }),
      ),
      // En retrait par rapport aux adresses : contour fin et pointillé.
      style: { fill: "none", stroke: POSTER.jauneTexte, strokeWidth: 1.1, dash: "4 3" },
      labelMode: "number",
      labelProperty: "nom",
      sublabelProperty: "sub",
      labelColor: POSTER.jauneTexte,
      legendItem: { label: "Porte-à-porte : bureau de vote prioritaire", swatch: "fill" },
      visible: true,
      source: c.bvGeo!.source,
    });
  }
  // Logements sociaux : cercle proportionnel au nombre de logements, numéroté pour les rues à cibler.
  const rad = (n: number) => Math.max(5, Math.min(22, 2.2 * Math.sqrt(n)));
  if (ruesDots.length)
    layers.push({
      id: "hlm_autres",
      label: "Autres logements sociaux",
      kind: "points",
      data: fc(ruesDots.filter((r) => inBox(r.lon, r.lat)).map((r) => turf.point([r.lon, r.lat], { nom: `${r.voie}${r.nums.length ? ` (${numsTxt(r.nums)})` : ""}`, sub: `${fmtNumber(r.logements)} logements sociaux`, _r: Math.max(2.5, rad(r.logements) * 0.45) }))),
      style: { fill: "#e7b84a", stroke: "#fff", symbol: "dot", size: 8 },
      legendItem: { label: "Autres logements sociaux (20 et plus)", swatch: "dot" },
      visible: true,
      source: c.rpls!.source,
    });
  if (ruesNum.length)
    layers.push({
      id: "hlm",
      label: "Logements sociaux à cibler",
      kind: "points",
      data: fc(
        ruesNum
          .filter((r) => inBox(r.lon, r.lat))
          .map((r) =>
            turf.point([r.lon, r.lat], {
              nom: `${r.voie}${r.nums.length ? ` (${numsTxt(r.nums)})` : ""}`,
              sub: `${fmtNumber(r.logements)} logements sociaux${r.bv ? ` · bureau ${dv(r.bv)}${prioSet.has(r.bv) ? " (prioritaire)" : ""}` : ""}`,
              det: [r.noms.length ? `Résidence${r.noms.length > 1 ? "s" : ""} : ${r.noms.slice(0, 3).join(", ")}` : "", `${fmtNumber(r.logements)} logements sociaux${r.bv ? `, bureau ${dv(r.bv)}${prioSet.has(r.bv) ? " (prioritaire)" : ""}` : ""}`].filter(Boolean),
              quand: o.quandPorte ?? WEEKEND.porte,
              _r: rad(r.logements),
            }),
          ),
      ),
      style: { fill: POSTER.jaune, stroke: POSTER.charbon, symbol: "circle", size: 16 },
      labelMode: "number",
      labelProperty: "nom",
      sublabelProperty: "sub",
      labelColor: POSTER.charbon,
      legendItem: { label: "Porte-à-porte : logements sociaux (taille selon le nombre)", swatch: "circle" },
      visible: true,
      source: c.rpls!.source,
    });
  if (res.length)
    layers.push({
      id: "residences",
      label: "Résidences Crous et foyers de jeunes travailleurs",
      kind: "points",
      data: fc(
        res.map((r) => {
          const fjt = /foyer de jeunes/i.test(r.categorie);
          return turf.point([r.lon, r.lat], {
            nom: r.nom,
            sub: [fjt ? "Foyer de jeunes travailleurs" : "Résidence du Crous", r.logements ? `${fmtNumber(r.logements)} logements` : "", r.adresse].filter(Boolean).join(" · "),
            det: [`${fjt ? "Foyer de jeunes travailleurs" : "Résidence du Crous"}${r.logements ? `, ${fmtNumber(r.logements)} logements` : ""}`, r.adresse ? `Adresse : ${r.adresse}` : "", fjt ? "Jeunes actifs, souvent peu inscrits sur les listes" : "Inscription sur les listes et mobilisation des étudiants"].filter(Boolean),
            quand: fjt ? WEEKEND.foyer : WEEKEND.crous,
          });
        }),
      ),
      style: { fill: RESIDENCE_RED, stroke: "#ffffff", symbol: "circle", size: 15 },
      labelMode: "number",
      labelProperty: "nom",
      sublabelProperty: "sub",
      labelColor: RESIDENCE_RED,
      legendItem: { label: "Porte-à-porte : résidence Crous, foyer", swatch: "circle" },
      visible: true,
      source: c.residences!.source,
    });
  const tract = [
    ...markets.map((m) => {
      const nom = /^march[ée]$/i.test(m.nom.trim()) ? "Marché" : m.nom;
      const h = /à (compléter|vérifier)/.test(m.infos) || !m.infos ? "" : weekendHours(m.infos) || m.infos;
      return { nom, sub: h ? `Marché · ${h}` : "Marché · jour du week-end à confirmer en mairie", det: ["Lieu de passage régulier des habitants", h ? `Horaires (OpenStreetMap, à confirmer) : ${h}` : "Jours et horaires à confirmer en mairie"], quand: m.quand ?? (h ? cap(h) : WEEKEND.marche), lon: m.lon!, lat: m.lat! };
    }),
    ...gares.map((g) => ({ nom: gareNom(g.nom), sub: g.voyageurs ? `${perDay(g.voyageurs)} · départs et retours de week-end` : "Départs et retours de week-end", det: [g.voyageurs ? `${perDay(g.voyageurs)} (moyenne de la semaine)` : "", "Départs et retours de week-end, étudiants"].filter(Boolean), quand: g.quand ?? WEEKEND.gare, lon: g.lon!, lat: g.lat! })),
    ...pts(o.stations ?? []).slice(0, 2).map((st) => ({ nom: st.nom, sub: `${/^Tram/.test(st.nom) ? "Tram" : /^RER/.test(st.nom) ? "RER" : "Métro"} · passage toute la journée`, det: [cap(st.infos), "Sortie de station : habitants qui font leurs courses, sortent ou rentrent"], quand: st.quand ?? WEEKEND.station, lon: st.lon!, lat: st.lat! })),
    ...pts(o.supermarches ?? []).slice(0, 2).map((v) => {
      const hyper = /hyper/.test(v.infos);
      return { nom: v.nom, sub: `${hyper ? "Hypermarché" : "Supermarché"} · affluence du samedi`, det: [v.infos ? cap(v.infos) : "", "Forte affluence le samedi, tous publics"].filter(Boolean), quand: v.quand ?? WEEKEND.supermarche, lon: v.lon!, lat: v.lat! };
    }),
  ].filter((t) => inBox(t.lon, t.lat));
  if (tract.length)
    layers.push({
      id: "tractage",
      label: "Lieux de tractage",
      kind: "points",
      data: fc(tract.map((t) => turf.point([t.lon, t.lat], { nom: t.nom, sub: t.sub, det: t.det, quand: t.quand }))),
      style: { fill: POSTER.violet, stroke: "#ffffff", symbol: "diamond", size: 17 },
      labelMode: "number",
      labelProperty: "nom",
      sublabelProperty: "sub",
      labelColor: POSTER.violet,
      legendItem: { label: `Tractage : ${["marché", "gare", ...(o.stations?.length ? ["métro"] : []), ...(o.supermarches?.length ? ["grande surface"] : [])].join(", ")} (week-end)`, swatch: "diamond" },
      visible: true,
      source: c.equipments?.source ?? c.stations?.source ?? geoSrc,
    });
  // Moment convivial de fin de journée (parc, grand bar) : un lieu, en vert.
  const conv = pts(o.convivial ?? []).filter((x) => inBox(x.lon!, x.lat!)).slice(0, 1);
  if (conv.length)
    layers.push({
      id: "convivial",
      label: "Moment convivial",
      kind: "points",
      data: fc(
        conv.map((x) =>
          turf.point([x.lon!, x.lat!], {
            nom: x.nom,
            sub: x.kind === "parc" ? cap(x.infos) : `Bar · ${x.infos}`,
            det: [x.kind === "parc" ? `${cap(x.infos)} : pique-nique ou apéro après l'action` : `Bar (${x.infos}) : verre de fin de journée`, "Avec les militants et les sympathisants rencontrés"],
            quand: x.quand ?? (x.kind === "parc" ? "Samedi midi (pique-nique) ou 18 h – 20 h" : "Samedi, 18 h – 20 h"),
          }),
        ),
      ),
      style: { fill: CONVIVIAL_GREEN, stroke: "#ffffff", symbol: "circle", size: 15 },
      labelMode: "number",
      labelProperty: "nom",
      sublabelProperty: "sub",
      labelColor: CONVIVIAL_GREEN,
      legendItem: { label: "Moment convivial : parc ou bar", swatch: "circle" },
      visible: true,
      source: c.convivialite?.source ?? geoSrc,
    });
  const sorties = ecoles.filter((e) => inBox(e.lon!, e.lat!));
  if (sorties.length)
    layers.push({
      id: "ecoles",
      label: "Sorties de collèges et lycées",
      kind: "points",
      data: fc(
        sorties.map((e) => {
          const lycee = /lyc[ée]e/i.test(`${e.type ?? ""} ${e.nom}`);
          return turf.point([e.lon!, e.lat!], {
            nom: e.nom,
            sub: [lycee ? "Lycée" : "Collège", e.infos].filter(Boolean).join(" · "),
            det: [e.infos ? cap(e.infos) : "", lycee ? "Lycéens, dont les premiers votants, et parents" : "Parents d'élèves"].filter(Boolean),
            quand: e.quand ?? "",
          });
        }),
      ),
      style: { fill: "#7a3fb8", stroke: "#ffffff", symbol: "square", size: 15 },
      labelMode: "number",
      labelProperty: "nom",
      sublabelProperty: "sub",
      labelColor: "#7a3fb8",
      legendItem: { label: "Tractage : sortie de collège ou lycée", swatch: "square" },
      visible: true,
      source: c.schools?.source ?? geoSrc,
    });
  return {
    id: "lfi_affiche",
    title: `${commune.nom} : propositions de ciblage, porte-à-porte et tractage`,
    theme: "strategie",
    bbox,
    poster: {
      kicker: commune.nom,
      title: "Propositions de ciblage : porte-à-porte et tractage",
      source: "Source : Pôle d'études électorales. Fond de carte : © contributeurs OpenStreetMap, IGN.",
      footnote: "Périmètres et emplacements indicatifs. Numéros : voir la liste « Où agir ».",
      scaleBar: true,
    },
    layers,
    note: `Porte-à-porte : bureaux de vote prioritaires${ruesNum.length ? ", logements sociaux rue par rue (répertoire RPLS)" : ""}${res.length ? ", résidences du Crous et foyers" : ""} ; tractage : ${[markets.length ? "marchés" : "", gares.length ? "gares" : "", (o.stations ?? []).length ? "stations de métro, RER, tram" : "", (o.supermarches ?? []).length ? "grandes surfaces" : "", sorties.length ? "sorties de collèges et lycées" : ""].filter(Boolean).join(", ") || "à compléter"}.`,
  };
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
