import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { internalDir, loadInternalData, parseCsv } from "@/lib/collectors/interne";
import { communeActuelle, referentiel } from "@/lib/collectors/admin";
import { buildNational, natJob, readNational } from "@/lib/national/donnees";
import { classer, fusionnerCommunes, parseMobilisables, parseNegos, type Militant } from "@/lib/national/score";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Classement national : notes des trois facteurs par commune (la pondération se fait dans la page). */
export async function GET(req: Request) {
  const min = Math.max(1000, Number(new URL(req.url).searchParams.get("min") ?? 3500) || 3500);
  const nat = await readNational();
  if (!nat) return NextResponse.json({ job: natJob(), builtAt: null, lignes: [] });
  const int = await loadInternalData().catch(() => null);
  const bilan = int?.bilan ? new Map<string, Militant>([...int.bilan].map(([k, b]) => [k, { ga: b.ga, actions: b.actions, soutiens: b.parrains }])) : null;
  let negos: Map<string, number> | null = null;
  try {
    negos = parseNegos(parseCsv(await fs.readFile(path.join(internalDir(), "negos.csv"), "utf8")));
  } catch {
    /* pas de fichier de projections */
  }
  let mobilisables: Map<string, number> | null = null;
  try {
    const m = parseMobilisables(parseCsv(await fs.readFile(path.join(internalDir(), "mobilisables.csv"), "utf8")), () => null);
    mobilisables = new Map();
    for (const [k, v] of m) mobilisables.set(communeActuelle(k), (mobilisables.get(communeActuelle(k)) ?? 0) + v);
  } catch {
    /* pas d'export de Damien */
  }
  const ref = referentiel();
  const communes = fusionnerCommunes(nat.communes, communeActuelle, (k) => ref.byCode.get(k)?.nom);
  const interco = (k: string) => ref.eptByCommune.get(k)?.code ?? ref.epciByCommune.get(k)?.code ?? null;
  // Les écarts projetés par circonscription ne quittent pas le serveur : seule la note (rang) est envoyée.
  const lignes = classer(communes, { minInscrits: min, bilan, negos, mobilisables, interco }).map(({ ecartCirco: _e, ecartSource: _s, ...l }) => ({
    ...l,
    depNom: ref.departements.get(l.dep)?.nom ?? l.dep,
    regNom: ref.regions.get(l.reg)?.nom ?? "",
  }));
  return NextResponse.json({ job: natJob(), builtAt: nat.builtAt, communes: communes.length, bilan: !!bilan, mobilisables: mobilisables?.size ?? 0, lignes });
}

/** Lance (ou relance) la construction du jeu de données national, en tâche de fond. */
export async function POST() {
  if (!natJob().running) void buildNational().catch(() => undefined);
  return NextResponse.json({ job: natJob() });
}
