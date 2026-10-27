import type { BpeNational } from "../collectors/bpe";
import { BOURG_CODES, centreBourg, OFFRE_KM, SERVICE_CATS } from "./services";

/**
 * Référence nationale de l'accès aux services : pour chaque service, ce dont dispose l'habitant moyen
 * en France (médiane pondérée par la population de toutes les communes) :
 * - distance au plus proche (0 km s'il est dans la commune) ;
 * - nombre pour 10 000 habitants dans un rayon de 5 km.
 * Calculée une fois à partir du fichier national (grille de 0,05° pour les recherches de voisinage).
 */

export type ServicesRef = Record<string, { dist?: number; offre?: number }>;

type C = { code: string; lon: number; lat: number; pop: number };
const CELL = 0.05;
const cellOf = (lon: number, lat: number) => [Math.floor(lon / CELL), Math.floor(lat / CELL)] as const;
const dkm = (lon1: number, lat1: number, lon2: number, lat2: number) => Math.hypot((lon2 - lon1) * Math.cos(((lat1 + lat2) * Math.PI) / 360), lat2 - lat1) * 111.2;

function weightedMedian(vals: { v: number; w: number }[]): number {
  const xs = vals.filter((x) => Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
  const tot = xs.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of xs) {
    acc += x.w;
    if (acc >= tot / 2) return x.v;
  }
  return NaN;
}

export function nationalServiceRefs(communes0: C[], bpe: BpeNational): ServicesRef {
  // Centre habité de chaque commune (équipements du quotidien), comme pour la commune étudiée.
  const parCommune = new Map<string, { lon: number; lat: number }[]>();
  for (const code of BOURG_CODES) {
    const t = bpe.byType[code];
    if (!t) continue;
    for (let i = 0; i < t.commune.length; i++) if (Number.isFinite(t.lon[i]) && Number.isFinite(t.lat[i])) (parCommune.get(t.commune[i]) ?? parCommune.set(t.commune[i], []).get(t.commune[i])!).push({ lon: t.lon[i], lat: t.lat[i] });
  }
  const communes = communes0.map((c) => {
    const b = centreBourg(parCommune.get(c.code) ?? []);
    return b ? { ...c, lon: b[0], lat: b[1] } : c;
  });
  const centre = new Map(communes.map((c) => [c.code, c]));
  // Communes à moins de 5 km de chacune (population à portée).
  const cgrid = new Map<string, C[]>();
  for (const c of communes) {
    const [x, y] = cellOf(c.lon, c.lat);
    const k = `${x}|${y}`;
    (cgrid.get(k) ?? cgrid.set(k, []).get(k)!).push(c);
  }
  const R = 2; // 2 cellules de 0,05° couvrent 5 km à toutes les latitudes de métropole
  const popPortee = new Map<string, number>();
  for (const c of communes) {
    const [x, y] = cellOf(c.lon, c.lat);
    let p = 0;
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) for (const o of cgrid.get(`${x + dx}|${y + dy}`) ?? []) if (o === c || dkm(c.lon, c.lat, o.lon, o.lat) <= OFFRE_KM) p += o.pop;
    popPortee.set(c.code, p);
  }
  const out: ServicesRef = {};
  for (const cat of SERVICE_CATS)
    for (const it of cat.items) {
      // Points de ce service (sans coordonnées : centre de la commune).
      const pts: { lon: number; lat: number; commune: string }[] = [];
      for (const code of it.codes) {
        const t = bpe.byType[code];
        if (!t) continue;
        for (let i = 0; i < t.commune.length; i++) {
          const c = centre.get(t.commune[i]);
          const lon = Number.isFinite(t.lon[i]) ? t.lon[i] : c?.lon;
          const lat = Number.isFinite(t.lat[i]) ? t.lat[i] : c?.lat;
          if (lon == null || lat == null) continue;
          pts.push({ lon, lat, commune: t.commune[i] });
        }
      }
      if (pts.length < 10) continue;
      const grid = new Map<string, number[]>();
      const own = new Map<string, number>();
      pts.forEach((p, i) => {
        const [x, y] = cellOf(p.lon, p.lat);
        const k = `${x}|${y}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
        own.set(p.commune, (own.get(p.commune) ?? 0) + 1);
      });
      // Distance au plus proche : anneaux de cellules autour de la commune jusqu'à être sûr du résultat.
      const nearest = (c: C) => {
        if (own.has(c.code)) return 0;
        const [x, y] = cellOf(c.lon, c.lat);
        const kmCell = CELL * 111.2 * Math.cos((c.lat * Math.PI) / 180);
        let best = Infinity;
        for (let r = 0; r <= 80; r++) {
          if (best <= (r - 1) * kmCell) break;
          for (let dx = -r; dx <= r; dx++)
            for (let dy = -r; dy <= r; dy++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              for (const i of grid.get(`${x + dx}|${y + dy}`) ?? []) best = Math.min(best, dkm(c.lon, c.lat, pts[i].lon, pts[i].lat));
            }
        }
        return best;
      };
      // Offre à portée : équipements à moins de 5 km, plus ceux de la commune au-delà (grandes communes).
      const offre = (c: C) => {
        const [x, y] = cellOf(c.lon, c.lat);
        let n = 0;
        let ownNear = 0;
        for (let dx = -R; dx <= R; dx++)
          for (let dy = -R; dy <= R; dy++)
            for (const i of grid.get(`${x + dx}|${y + dy}`) ?? []) {
              if (dkm(c.lon, c.lat, pts[i].lon, pts[i].lat) <= OFFRE_KM) {
                n++;
                if (pts[i].commune === c.code) ownNear++;
              }
            }
        n += (own.get(c.code) ?? 0) - ownNear;
        const p = popPortee.get(c.code) ?? 0;
        return p > 0 ? (10000 * n) / p : NaN;
      };
      const ref: { dist?: number; offre?: number } = {};
      ref.dist = weightedMedian(communes.map((c) => ({ v: nearest(c), w: Math.max(1, c.pop) })));
      if (it.mode !== "distance") ref.offre = weightedMedian(communes.map((c) => ({ v: offre(c), w: Math.max(1, c.pop) })));
      out[it.label] = ref;
    }
  return out;
}
