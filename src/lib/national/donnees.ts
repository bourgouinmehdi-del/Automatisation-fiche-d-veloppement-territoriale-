import { promises as fs } from "node:fs";
import path from "node:path";
import { departementGeo, referentiel } from "../collectors/admin";
import { circoCommunes, collectCirconscriptions } from "../collectors/carto";
import { TrackedHttp } from "../collectors/context";
import { collectDepartementElection, ELECTIONS, type ElectionResult } from "../collectors/elections";
import { familyVotes } from "../analysis/political";
import { config } from "../config";
import type { NatCommune } from "./score";

/**
 * Jeu de données national du classement : résultats par commune (présidentielle 2022, européennes 2024,
 * législatives 2024) et circonscription de chaque commune, département par département. Construit à la
 * demande (bouton de la page), en tâche de fond : une à deux heures la première fois, les extractions
 * départementales étant ensuite en cache. Données publiques seulement ; le bilan militant est croisé à la
 * lecture.
 */
export const NAT_FILE = () => path.join(config.dataDir, "national", "communes-v1.json");
/** Communes gardées : au moins ce nombre d'inscrits en 2022 (le classement filtre ensuite plus haut). */
const MIN_INSCRITS_STOCK = 1000;

export interface NatJob {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  errors: string[];
  startedAt: string | null;
  finishedAt: string | null;
}
const job: NatJob = { running: false, done: 0, total: 0, current: null, errors: [], startedAt: null, finishedAt: null };
export const natJob = () => ({ ...job, errors: job.errors.slice(-20) });

export async function readNational(): Promise<{ builtAt: string; communes: NatCommune[] } | null> {
  try {
    return JSON.parse(await fs.readFile(NAT_FILE(), "utf8"));
  } catch {
    return null;
  }
}

const sumFam = (e: string, a: { candidates: { label: string; voix: number }[]; inscrits: number; votants: number; exprimes: number }, ids: string[]) =>
  ids.reduce((s, id) => s + (familyVotes(e, a as never, id) ?? 0), 0);

/** Une commune de l'extraction départementale, ramenée aux quelques chiffres utiles. */
function byCode(r: ElectionResult | null) {
  return new Map((r?.byCommune ?? []).map((x) => [x.code, x]));
}

export async function buildNational(seulement?: string[]): Promise<void> {
  if (job.running) return;
  const ref = referentiel();
  const deps = seulement ?? [...ref.departements.keys()].sort();
  Object.assign(job, { running: true, done: 0, total: deps.length, current: null, errors: [], startedAt: new Date().toISOString(), finishedAt: null });
  const prev = await readNational();
  const keep = new Map((prev?.communes ?? []).map((c) => [c.code, c]));
  const out: NatCommune[] = [];
  try {
    for (const dep of deps) {
      job.current = ref.departements.get(dep)?.nom ?? dep;
      const http = new TrackedHttp();
      const any = ref.communes.find((c) => c.departement === dep && c.type === "commune-actuelle");
      if (!any) {
        job.done++;
        continue;
      }
      try {
        const get = async (id: string) => {
          const e = ELECTIONS.find((x) => x.id === id)!;
          try {
            return await collectDepartementElection(http, e, dep);
          } catch (err) {
            job.errors.push(`${job.current} ${id} : ${err instanceof Error ? err.message : err}`);
            return null;
          }
        };
        const [pr, eu, lg] = [byCode(await get("PR22T1")), byCode(await get("EU24")), byCode(await get("LG24T1"))];
        // Circonscription majoritaire de chaque commune (surface).
        const circo = new Map<string, { k: string; part: number }>();
        try {
          const [geo, cir] = await Promise.all([departementGeo(http, dep), collectCirconscriptions(http, dep)]);
          const feats = (geo.fc?.features ?? []).filter((f) => (pr.get(String(f.properties?.code))?.inscrits ?? 0) >= MIN_INSCRITS_STOCK);
          for (const c of cir.circos)
            for (const [code, part] of circoCommunes(feats, c)) if (part > (circo.get(code)?.part ?? 0)) circo.set(code, { k: c.code, part });
        } catch (err) {
          job.errors.push(`${job.current} circonscriptions : ${err instanceof Error ? err.message : err}`);
        }
        for (const [code, p] of pr) {
          if (p.inscrits < MIN_INSCRITS_STOCK) continue;
          const rc = ref.byCode.get(code);
          const e = eu.get(code);
          const l = lg.get(code);
          out.push({
            code,
            nom: rc?.nom ?? code,
            dep,
            reg: rc?.region ?? "",
            pop: rc?.population ?? null,
            circo: circo.get(code)?.k ?? null,
            circoPart: circo.get(code)?.part ?? null,
            pr22: { inscrits: p.inscrits, votants: p.votants, exprimes: p.exprimes, lfi: sumFam("PR22T1", p, ["lfi"]), gauche: sumFam("PR22T1", p, ["pcf", "ps", "eco"]) },
            eu24: e ? { inscrits: e.inscrits, votants: e.votants, exprimes: e.exprimes, lfi: sumFam("EU24", e, ["lfi"]) } : null,
            lg24: l
              ? {
                  inscrits: l.inscrits,
                  exprimes: l.exprimes,
                  nfp: sumFam("LG24T1", l, ["nfp"]),
                  adv: Object.fromEntries(["rn", "ens", "lr", "rec"].map((f) => [f, familyVotes("LG24T1", l as never, f) ?? 0])),
                }
              : null,
          });
        }
        if (!pr.size) for (const c of keep.values()) if (c.dep === dep) out.push(c);
      } catch (err) {
        job.errors.push(`${job.current} : ${err instanceof Error ? err.message : err}`);
        for (const c of keep.values()) if (c.dep === dep) out.push(c);
      }
      job.done++;
    }
    await fs.mkdir(path.dirname(NAT_FILE()), { recursive: true });
    await fs.writeFile(NAT_FILE(), JSON.stringify({ builtAt: new Date().toISOString(), communes: out }));
  } finally {
    job.running = false;
    job.current = null;
    job.finishedAt = new Date().toISOString();
  }
}
