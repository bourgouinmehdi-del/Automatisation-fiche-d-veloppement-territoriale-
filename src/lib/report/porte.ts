import * as turf from "@turf/turf";
import { hlmByStreet, numsLabel } from "../collectors/rpls";
import type { BvRow } from "../analysis/political";
import type { Adresse } from "../collectors/ban";
import { fmtNumber } from "../format";
import type { Block, DataTable, MapSpec, Section } from "../types";
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
  if (!prio.length) return out;
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `Une page par bureau prioritaire : rues et numéros à couvrir, d'après la Base adresse nationale. Chaque adresse est rattachée au bureau dont le contour la contient : en limite de bureau, le rattachement peut être approximatif. Une adresse peut regrouper plusieurs logements (immeubles).`,
    },
  ];
  for (const b of prio) {
    const poly = geo.features.find((f) => String(f.properties?.bv) === b.bv);
    if (!poly) continue;
    const bb = turf.bbox(poly);
    const inside = adr.list.filter(
      (a) => a.lon >= bb[0] && a.lon <= bb[2] && a.lat >= bb[1] && a.lat <= bb[3] && turf.booleanPointInPolygon([a.lon, a.lat], poly as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>),
    );
    if (!inside.length) continue;
    const streets = streetsOf(inside);
    const label = labels.get(b.bv);
    const title = `Bureau ${dv(b.bv)}${label ? ` — ${label}` : ""}`;
    const place = placeOf(b.bv);
    blocks.push({ type: "heading", text: `Porte-à-porte : ${title}` });
    blocks.push({
      type: "paragraph",
      text: `**${fmtNumber(b.inscrits)} électeurs inscrits** pour ${fmtNumber(inside.length)} adresses dans ${fmtNumber(streets.length)} rues${place ? ` ; lieu de vote : ${place}` : ""}. Vote LFI aux européennes 2024 : ${pp(b.lfiPctIns)} des inscrits${b.lfi2PctIns != null ? ` (Mélenchon 2022 : ${pp(b.lfi2PctIns)})` : ""} ; **${fmtNumber(b.abstN)} inscrits n'ont pas voté** (${pp(b.abstPct)}).`,
    });
    // Résidences HLM du bureau (RPLS) : souvent les immeubles où frapper en premier.
    const hlm = (c.rpls?.residences ?? [])
      .filter((r) => r.logements >= 5 && r.lon >= bb[0] && r.lon <= bb[2] && r.lat >= bb[1] && r.lat <= bb[3] && turf.booleanPointInPolygon([r.lon, r.lat], poly as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>));
    // Rue par rue : « Allée Nicolas Copernic (n° 2 et 4), 119 logements ».
    const rues = hlmByStreet(hlm).filter((r) => r.logements >= 10).slice(0, 6);
    if (rues.length)
      blocks.push({
        type: "paragraph",
        text: `**Résidences HLM du bureau** : ${rues.map((r) => `${r.voie}${r.nums.length ? ` (${numsLabel(r.nums)})` : ""}${r.noms.length ? `, ${r.noms.slice(0, 2).join(", ")}` : ""} : ${fmtNumber(r.logements)} logements`).join(" ; ")}.`,
      });
    // Carte : le bureau, ses voisins en gris clair, les adresses et le lieu de vote.
    const pad = 0.0015;
    const others = geo.features.filter((f) => f !== poly);
    const pts = inside.map((a) => turf.point([a.lon, a.lat], { nom: `${a.numero ?? ""}${a.rep ? ` ${a.rep}` : ""} ${a.voie}`.trim() }));
    const vote = geo.points.filter((p) => String(p.properties?.bv) === b.bv);
    const src = c.bvGeo!.source;
    out.maps.push({
      id: `porte_map_${b.bv}`,
      title: `${title} : adresses à couvrir`,
      theme: "strategie",
      bbox: [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad],
      layers: [
        { id: "voisins", label: "Autres bureaux", kind: "polygons", data: turf.featureCollection(others) as GeoJSON.FeatureCollection, color: "#ece6d6", visible: true, source: src },
        { id: "bureau", label: `Bureau ${dv(b.bv)}`, kind: "polygons", data: turf.featureCollection([{ ...poly, properties: { ...poly.properties, nom: title } }]) as GeoJSON.FeatureCollection, color: "#c9adff", visible: true, source: src },
        { id: "adresses", label: "Adresses", kind: "points", data: turf.featureCollection(pts) as GeoJSON.FeatureCollection, color: "#4c0297", visible: true, source: adr.source },
        ...(vote.length ? [{ id: "vote", label: "Lieu de vote", kind: "points" as const, data: turf.featureCollection(vote) as GeoJSON.FeatureCollection, color: "#d1271c", visible: true, source: src }] : []),
      ],
      legend: {
        title: "Légende",
        categories: [
          { label: `Bureau ${dv(b.bv)}`, color: "#c9adff" },
          { label: "Adresse", color: "#4c0297" },
          ...(vote.length ? [{ label: "Lieu de vote", color: "#d1271c" }] : []),
        ],
      },
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
  out.section = { id: "PORTE", letter: "", title: "Feuilles de porte-à-porte (bureaux prioritaires)", blocks };
  return out;
}
