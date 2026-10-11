import type { TrackedHttp } from "./context";

/**
 * Temps de trajet routiers (calculateur OSRM, données OpenStreetMap).
 * Par défaut, le serveur de démonstration public d'OSRM, adapté à un usage
 * ponctuel ; renseigner OSRM_URL pour une instance dédiée.
 */

export const OSRM_URL = (process.env.OSRM_URL ?? "https://router.project-osrm.org").replace(/\/$/, "");

export interface Route {
  label: string;
  nom: string;
  minutes: number;
  km: number;
}

export async function collectRoutes(http: TrackedHttp, from: [number, number], targets: { label: string; nom: string; to: [number, number] }[]): Promise<{ routes: Route[]; url: string; retrievedAt: string }> {
  const routes: Route[] = [];
  let url = "";
  let retrievedAt = "";
  for (const t of targets) {
    const u = `${OSRM_URL}/route/v1/driving/${from[0].toFixed(5)},${from[1].toFixed(5)};${t.to[0].toFixed(5)},${t.to[1].toFixed(5)}?overview=false`;
    const r = await http.json<{ code?: string; routes?: { duration: number; distance: number }[] }>(u, { minIntervalMs: 1100 });
    url ||= u;
    retrievedAt = r.retrievedAt;
    const best = r.data?.routes?.[0];
    if (r.data?.code === "Ok" && best) routes.push({ label: t.label, nom: t.nom, minutes: Math.round(best.duration / 60), km: Math.round(best.distance / 1000) });
  }
  if (!routes.length) throw new Error("Aucun itinéraire calculé");
  return { routes, url, retrievedAt };
}

/** « 1 h 15 », « 35 min ». */
export const fmtDuration = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${String(min % 60).padStart(2, "0")}` : ""}` : `${min} min`);
