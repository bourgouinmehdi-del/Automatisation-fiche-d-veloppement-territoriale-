import * as turf from "@turf/turf";
import { hlmByStreet, numsLabel } from "../collectors/rpls";
import type { BvRow } from "../analysis/political";
import type { Adresse } from "../collectors/ban";
import { fmtNumber } from "../format";
import type { Block, DataTable, MapLayer, MapSpec, Section } from "../types";
import { fitAspect } from "../collectors/carto";
import { POSTER } from "../render/poster";
import type { Collected } from "./collect";

/**
 * Feuilles de porte-à-porte : pour chaque bureau prioritaire, les rues et
 * numéros à couvrir (Base adresse nationale, rattachés au bureau par leur
 * position dans les contours), une carte et le lieu de vote, sur une page
 * imprimable par bureau.
 */

export interface PorteOutput {
  section: Section | null;
  tables: DataTable[];
  maps: MapSpec[];
}

/** Largeur et teinte des voies par classe (comme sur la carte « affiche »). */
const ROAD: Record<number, [number, string]> = { 1: [2.8, "#bfb5a3"], 2: [2.1, "#c8bfae"], 3: [1.6, "#cfc7b7"], 4: [1.15, "#d6cebf"], 5: [0.9, "#d6cebf"] };
const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Emprise élargie à une proportion hauteur / largeur donnée (projection de Mercator). */
function toAspect(b: [number, number, number, number], want: number): [number, number, number, number] {
  const [w, so, e, n] = b;
  const k = 1 / Math.cos((((so + n) / 2) * Math.PI) / 180);
  const ratio = ((n - so) * k) / (e - w || 1e-6);
  if (ratio > want) {
    const add = (((n - so) * k) / want - (e - w)) / 2;
    return [w - add, so, e + add, n];
  }
  const add = ((want * (e - w)) / k - (n - so)) / 2;
  return [w, so - add, e, n + add];
}

const pp = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "n.d." : `${Math.round(v)}\u00a0%`);

/** « 1 à 45 » à partir d'une liste de numéros. */
function range(nums: number[]) {
  if (!nums.length) return "";
  const s = [...nums].sort((a, b) => a - b);
  return s[0] === s[s.length - 1] ? `${s[0]}` : `${s[0]} à ${s[s.length - 1]}`;
}

export function streetsOf(adresses: Adresse[]) {
  const by = new Map<string, Adresse[]>();
  for (const a of adresses) {
    const k = a.voie || "(voie sans nom)";
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(a);
  }
  return [...by.entries()]
    .map(([voie, as]) => {
      const nums = [...new Set(as.map((a) => a.numero).filter((n): n is number => n != null))];
      const odd = nums.filter((n) => n % 2 === 1);
      const even = nums.filter((n) => n % 2 === 0);
      const parts = [odd.length ? `impairs ${range(odd)}` : "", even.length ? `pairs ${range(even)}` : ""].filter(Boolean);
      return { voie, adresses: as.length, numeros: parts.join(" ; ") || "sans numéro" };
    })
    .sort((a, b) => b.adresses - a.adresses || a.voie.localeCompare(b.voie, "fr"));
}

export function buildPorte(c: Collected, ranked: BvRow[], labels: Map<string, string>, placeOf: (bv: string) => string, dv: (bv: string) => string = (x) => x): PorteOutput {
  const out: PorteOutput = { section: null, tables: [], maps: [] };
  const geo = c.bvGeo;
  const adr = c.adresses;
  if (!geo?.features.length || !adr?.list.length) return out;
  const prio = ranked.filter((b) => b.priorite === 1);
  const osmNom = new Map<string, string>();
  for (const r of c.fond?.roads ?? []) {
    const n = r.properties?.n as string | undefined;
    if (n && !osmNom.has(norm(n))) osmNom.set(norm(n), n);
  }
  if (!prio.length) return out;
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `Une page par bureau prioritaire : les chiffres du bureau, la carte des adresses et la liste des rues à cocher. Une adresse peut regrouper plusieurs logements (immeubles). En limite de bureau, le rattachement d'une adresse peut être approximatif.`,
    },
  ];
  // Page 1 : la liste des bureaux, chacun détaillé ensuite sur sa propre page.
  const sommaire: { text: string }[] = [];
  for (const b of prio) {
    const poly = geo.features.find((f) => String(f.properties?.bv) === b.bv);
    if (!poly) continue;
    const bb = turf.bbox(poly);
    const inside = adr.list.filter(
      (a) => a.lon >= bb[0] && a.lon <= bb[2] && a.lat >= bb[1] && a.lat <= bb[3] && turf.booleanPointInPolygon([a.lon, a.lat], poly as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>),
    );
    if (!inside.length) continue;
    // Noms de rues de la Base adresse parfois sans accents (« Allee de la Foret ») : graphie d'OpenStreetMap si elle correspond.
    const streets = streetsOf(inside).map((st) => ({ ...st, voie: osmNom.get(norm(st.voie)) ?? st.voie }));
    const label = labels.get(b.bv);
    const title = `Bureau ${dv(b.bv)}${label ? ` — ${label}` : ""}`;
    const place = placeOf(b.bv);
    blocks.push({ type: "heading", text: `Porte-à-porte : ${title}` });
    sommaire.push({ text: `${title} : ${fmtNumber(inside.length)} adresses, ${fmtNumber(b.abstN)} inscrits n'ont pas voté (${pp(b.abstPct)}), vote LFI à ${pp(b.lfiPctExp)}` });
    // Chiffres clés en vignettes plutôt qu'en phrase (lecture d'un coup d'œil avant de partir).
    blocks.push({
      type: "glance",
      items: [
        { label: "Électeurs inscrits", value: fmtNumber(b.inscrits), tone: "socio" },
        { label: "N'ont pas voté", value: fmtNumber(b.abstN), detail: `${pp(b.abstPct)} des inscrits`, tone: "socio" },
        { label: "Vote LFI (européennes 2024)", value: pp(b.lfiPctExp), detail: b.lfi2PctExp != null ? `Mélenchon 2022 : ${pp(b.lfi2PctExp)}` : undefined, tone: "socio" },
      ],
    });
    blocks.push({ type: "paragraph", text: `**${fmtNumber(inside.length)} adresses** dans ${fmtNumber(streets.length)} rue${streets.length > 1 ? "s" : ""}${place ? `. **Lieu de vote** : ${place}` : ""}.` });
    // Résidences HLM du bureau (RPLS) : souvent les immeubles où frapper en premier.
    const hlm = (c.rpls?.residences ?? [])
      .filter((r) => r.logements >= 5 && r.lon >= bb[0] && r.lon <= bb[2] && r.lat >= bb[1] && r.lat <= bb[3] && turf.booleanPointInPolygon([r.lon, r.lat], poly as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>));
    // Rue par rue : « Allée Nicolas Copernic (n° 2 et 4) : 119 logements ». Les noms de programme qui
    // reprennent seulement la commune (« Farebersviller Col ») n'apportent rien.
    const rues = hlmByStreet(hlm).filter((r) => r.logements >= 10).slice(0, 6);
    const utile = (nom: string) => !norm(nom).startsWith(norm(c.commune.nom));
    if (rues.length)
      blocks.push({
        type: "list",
        title: "Logements sociaux du bureau, à frapper en premier",
        items: rues.map((r) => {
          const noms = r.noms.filter(utile).slice(0, 2);
          return { text: `${r.voie}${r.nums.length ? ` (${numsLabel(r.nums)})` : ""} : ${fmtNumber(r.logements)} logements${noms.length ? ` (${noms.join(", ")})` : ""}` };
        }),
      });
    // Carte sur fond de plan (rues nommées), cadrée sur les adresses du bureau et le lieu de vote.
    const vote = geo.points.filter((p) => String(p.properties?.bv) === b.bv);
    const src = c.bvGeo!.source;
    const ptsAll: [number, number][] = [...inside.map((a) => [a.lon, a.lat] as [number, number]), ...vote.map((v) => (v.geometry as GeoJSON.Point).coordinates as [number, number])];
    let fb: [number, number, number, number] = [Math.min(...ptsAll.map((x) => x[0])), Math.min(...ptsAll.map((x) => x[1])), Math.max(...ptsAll.map((x) => x[0])), Math.max(...ptsAll.map((x) => x[1]))];
    // 600 m de côté au moins.
    const minDeg = 0.0055;
    if (fb[3] - fb[1] < minDeg) fb = [fb[0], fb[1] - (minDeg - (fb[3] - fb[1])) / 2, fb[2], fb[3] + (minDeg - (fb[3] - fb[1])) / 2];
    if (fb[2] - fb[0] < minDeg * 1.5) fb = [fb[0] - (minDeg * 1.5 - (fb[2] - fb[0])) / 2, fb[1], fb[2] + (minDeg * 1.5 - (fb[2] - fb[0])) / 2, fb[3]];
    // Cadre plutôt en largeur (0,72) : la carte tient sur la page avec les chiffres du bureau.
    const bbox = toAspect(fitAspect(fb, 0.12), 0.72);
    const ruesBv = new Set(streets.map((st) => norm(st.voie)));
    const others = geo.features.filter((f) => f !== poly);
    const fond = c.fond;
    const layers: MapLayer[] = [
      {
        id: "voisins",
        label: "Autres bureaux",
        kind: "polygons",
        data: turf.featureCollection(others.map((f) => ({ ...f, properties: { num: `BV ${dv(String(f.properties?.bv))}` } }))) as GeoJSON.FeatureCollection,
        style: { fill: POSTER.creme, stroke: "#b9b2a4", strokeWidth: 0.8 },
        labelMode: "tag",
        labelProperty: "num",
        legendItem: { label: "Autres bureaux de vote", swatch: "fill" },
        visible: true,
        source: src,
      },
      {
        id: "bureau",
        label: `Bureau ${dv(b.bv)}`,
        kind: "polygons",
        data: turf.featureCollection([{ ...poly, properties: {} }]) as GeoJSON.FeatureCollection,
        style: { fill: "#eadcff", stroke: "none" },
        legendItem: { label: `Bureau ${dv(b.bv)} (à couvrir)`, swatch: "fill" },
        visible: true,
        source: src,
      },
      ...(fond?.roads.length
        ? [
            {
              id: "voies",
              label: "Rues",
              kind: "lines" as const,
              data: turf.featureCollection(
                [...fond.roads]
                  .sort((x, y) => (y.properties?.c ?? 5) - (x.properties?.c ?? 5))
                  .map((r) => {
                    const cl = (r.properties?.c ?? 5) as number;
                    const n = r.properties?.n as string | undefined;
                    const dans = !!n && ruesBv.has(norm(n));
                    return { ...r, properties: { _sw: ROAD[cl][0], _stroke: ROAD[cl][1], ...(n && (dans || cl <= 3) ? { n, _rank: dans ? 0 : cl } : {}) } };
                  }),
              ) as GeoJSON.FeatureCollection,
              labelMode: "road" as const,
              labelProperty: "n",
              visible: true,
              source: fond.source,
            },
          ]
        : []),
      // Contour du bureau au-dessus des rues.
      { id: "bureau_contour", label: "Limite du bureau", kind: "polygons", data: turf.featureCollection([{ ...poly, properties: {} }]) as GeoJSON.FeatureCollection, style: { fill: "none", stroke: POSTER.violet, strokeWidth: 2.2 }, visible: true, source: src },
      {
        id: "adresses",
        label: "Adresses",
        kind: "points",
        data: turf.featureCollection(inside.map((a) => turf.point([a.lon, a.lat]))) as GeoJSON.FeatureCollection,
        style: { fill: POSTER.violet, symbol: "dot", size: 7 },
        legendItem: { label: "Adresse à couvrir", swatch: "dot" },
        visible: true,
        source: adr.source,
      },
      ...(vote.length
        ? [
            {
              id: "vote",
              label: "Lieu de vote",
              kind: "points" as const,
              data: turf.featureCollection(vote.map((v) => ({ ...v, properties: { nom: "Lieu de vote" } }))) as GeoJSON.FeatureCollection,
              style: { fill: "#d1271c", stroke: "#fff", symbol: "square" as const, size: 14 },
              labelMode: "callout" as const,
              labelProperty: "nom",
              labelColor: "#d1271c",
              legendItem: { label: "Lieu de vote", swatch: "square" as const },
              visible: true,
              source: src,
            },
          ]
        : []),
    ];
    out.maps.push({
      id: `porte_map_${b.bv}`,
      title: `${title} : adresses à couvrir`,
      theme: "strategie",
      bbox,
      poster: {
        kicker: `Bureau ${dv(b.bv)}`,
        title: "Adresses à couvrir",
        source: "Fond de carte : © contributeurs OpenStreetMap. Adresses : Base adresse nationale.",
        scaleBar: true,
        compact: true,
      },
      layers,
      note: "Contours de bureaux approximatifs ; adresses de la Base adresse nationale.",
    });
    blocks.push({ type: "map", mapId: `porte_map_${b.bv}` });
    const max = 70;
    out.tables.push({
      id: `porte_rues_${b.bv}`,
      title: `${title} : rues à couvrir (${fmtNumber(streets.length)})`,
      theme: "strategie",
      columns: [
        { key: "fait", label: "Fait" },
        { key: "voie", label: "Rue", wide: true },
        { key: "numeros", label: "Numéros" },
        { key: "adresses", label: "Adresses", align: "right" },
        { key: "notes", label: "Notes (portes ouvertes, contacts)", wide: true },
      ],
      rows: streets.slice(0, max).map((s) => ({ fait: "☐", voie: s.voie, numeros: s.numeros, adresses: s.adresses, notes: "" })),
      sources: [adr.source, src],
      note: `Rues classées par nombre d'adresses.${streets.length > max ? ` ${streets.length - max} petites rues non listées (${fmtNumber(streets.slice(max).reduce((n, s) => n + s.adresses, 0))} adresses).` : ""} Premier et dernier numéro de chaque côté de la rue : certains numéros intermédiaires peuvent manquer.`,
    });
    blocks.push({ type: "table", tableId: `porte_rues_${b.bv}` });
  }
  if (blocks.length <= 1) return out;
  blocks.splice(1, 0, { type: "list", title: "Bureaux à couvrir (une page chacun)", items: sommaire });
  out.section = { id: "PORTE", letter: "", title: "Feuilles de porte-à-porte (bureaux prioritaires)", blocks };
  return out;
}
