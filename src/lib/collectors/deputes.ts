import Papa from "papaparse";
import * as turf from "@turf/turf";
import type { TrackedHttp } from "./context";
import { cachedExtract, heavyLane } from "../runtime";
import { findResource } from "./datagouv";
import { circoOf as circoOfProps, normDepCirco } from "./carto";
import { geoJsonFeatures, scanFile } from "./json-stream";
import type { DgResource } from "./datagouv";
import { promises as fs } from "node:fs";

/**
 * Député·es LFI en exercice (jeu « Députés actifs de l'Assemblée nationale » de Datan, mis à jour chaque
 * jour sur data.gouv.fr) et contour simplifié de leur circonscription : sert à proposer, dans « Organiser
 * la venue », les député·es dont la circonscription est proche de la commune.
 */
export const DEPUTES = { dataset: "deputes-actifs-de-lassemblee-nationale-informations-et-statistiques", fallback: { id: "092bd7bb-1543-405b-b53c-932ebb49bb8e", url: "https://www.data.gouv.fr/api/1/datasets/r/092bd7bb-1543-405b-b53c-932ebb49bb8e" } };
const DATAGOUV = "https://www.data.gouv.fr/api/1";

export interface DeputeLfi {
  nom: string;
  dep: string;
  depNom: string;
  circo: number;
  /** Contour simplifié de la circonscription (absent si introuvable). */
  geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

/** Lignes du CSV de Datan → député·es du groupe LFI. */
export function parseDeputesLfi(text: string): DeputeLfi[] {
  const rows = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: true }).data;
  return rows
    .filter((r) => /^LFI/i.test(String(r.groupeAbrev ?? "").trim()) || /insoumise/i.test(String(r.groupe ?? "")))
    .map((r) => ({ nom: `${String(r.prenom ?? "").trim()} ${String(r.nom ?? "").trim()}`.trim(), dep: normDepCirco(String(r.departementCode ?? "")), depNom: String(r.departementNom ?? "").trim(), circo: Number(r.circo) }))
    .filter((d) => d.nom && d.dep && Number.isFinite(d.circo));
}

export async function collectDeputesLfi(http: TrackedHttp): Promise<{ list: DeputeLfi[]; url: string; retrievedAt: string }> {
  return cachedExtract(
    "deputes-lfi",
    24,
    () =>
      heavyLane.run(async () => {
        const res = (await findResource(http, DEPUTES.dataset, /csv|deputes/i)) ?? (DEPUTES.fallback as DgResource);
        const f = await http.file(res.url ?? DEPUTES.fallback.url, { timeoutMs: 120000, retries: 1 });
        const list = parseDeputesLfi(await fs.readFile(f.data, "utf8"));
        // Contours des circonscriptions de ces député·es (fichier national lu en flux, contours simplifiés).
        const want = new Map(list.map((d) => [`${d.dep}-${d.circo}`, d]));
        try {
          const ds = await http.json<{ resources?: DgResource[] }>(`${DATAGOUV}/datasets/contours-geographiques-des-circonscriptions-legislatives/`);
          const r = (ds.data?.resources ?? []).filter((x) => /geo\s*json/i.test(x.format ?? "") || /\.geojson$/i.test(x.url ?? "")).sort((a, b) => (a.filesize ?? 0) - (b.filesize ?? 0))[0];
          if (r?.url) {
            const g = await http.file(r.url, { timeoutMs: 300000, retries: 1 });
            await scanFile(g.data, geoJsonFeatures, (t) => {
              try {
                const feat = JSON.parse(t) as GeoJSON.Feature;
                const c = circoOfProps(feat.properties as Record<string, unknown>);
                const d = c && want.get(`${c.dep}-${c.num}`);
                if (d && feat.geometry && /Polygon/.test(feat.geometry.type)) d.geometry = turf.simplify(feat as GeoJSON.Feature<GeoJSON.Polygon>, { tolerance: 0.003, highQuality: false }).geometry;
              } catch {
                /* entité illisible */
              }
            });
          }
        } catch {
          /* sans contours : pas de distance, la liste reste vide pour la fiche */
        }
        return { list, url: res.url ?? DEPUTES.fallback.url, retrievedAt: f.retrievedAt };
      }),
    (v) => v.list.length > 0,
  );
}

/** Député·es dont la circonscription est à moins de `km` du point (0 : la commune y est). */
export function deputesProches(list: DeputeLfi[], at: [number, number], km = 40): (DeputeLfi & { km: number })[] {
  const pt = turf.point(at);
  return list
    .filter((d) => d.geometry)
    .map((d) => {
      const f = turf.feature(d.geometry!);
      let dist = 0;
      try {
        if (!turf.booleanPointInPolygon(pt, f as GeoJSON.Feature<GeoJSON.Polygon>)) {
          const lines = turf.polygonToLine(f as GeoJSON.Feature<GeoJSON.Polygon>);
          const ls = lines.type === "FeatureCollection" ? lines.features : [lines];
          dist = Math.min(...ls.map((l) => turf.pointToLineDistance(pt, l as GeoJSON.Feature<GeoJSON.LineString>, { units: "kilometers" })));
        }
      } catch {
        dist = Infinity;
      }
      return { ...d, km: dist };
    })
    .filter((d) => d.km <= km)
    .sort((a, b) => a.km - b.km);
}
