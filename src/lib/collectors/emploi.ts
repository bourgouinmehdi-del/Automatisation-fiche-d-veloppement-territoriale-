import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { internalDir } from "./interne";

/**
 * Demandeurs d'emploi inscrits à France Travail, par commune de résidence et
 * par mois (fichiers « RES_STMT_COM » et « RES_NAT » : statistiques du marché
 * du travail). Colonnes :
 *
 *   COMRES   code INSEE de la commune de résidence (vide dans le fichier national)
 *   MOISTA   mois (AAAAMM)
 *   _FREQ_   nombre de demandeurs d'emploi
 *   part_fem part de femmes (0 à 1)
 *   AGE_m    âge moyen
 *   ancien_m ancienneté moyenne d'inscription, en jours
 *   ancien_mn variante de l'ancienneté, publiée à partir de 2025
 *
 * Les caractéristiques sont absentes pour les très petits effectifs (secret
 * statistique). Ces fichiers ne sont pas publics : ils sont déposés depuis la
 * page « Données internes » et restent dans data/interne/ (jamais versionnés).
 *
 * Le fichier communal (≈ 230 Mo) est découpé une fois pour toutes, à son dépôt,
 * en un fichier par département : une fiche ne lit ensuite que le sien.
 */

export interface StmtPoint {
  mois: string;
  n: number;
  fem: number | null;
  age: number | null;
  anc: number | null;
}

export interface StmtSeries {
  commune: StmtPoint[];
  departement: StmtPoint[];
  france: StmtPoint[];
  /** Codes réellement trouvés (arrondissements pour Paris, Lyon, Marseille). */
  codes: string[];
}

export const stmtDir = () => path.join(internalDir(), "demandeurs-emploi");
const HEADER = /^﻿?COMRES;MOISTA;_FREQ_;part_fem;AGE_m;ancien_m/i;

export const depOfCommune = (code: string) => (/^97/.test(code) ? code.slice(0, 3) : code.slice(0, 2));

async function* lines(input: Readable, gzip: boolean) {
  const rl = readline.createInterface({ input: gzip ? input.pipe(createGunzip()) : input, crlfDelay: Infinity });
  for await (const l of rl) yield l;
}

export interface StmtImportResult {
  kind: "communes" | "national";
  rows: number;
  communes: number;
  first: string;
  last: string;
}

/**
 * Import en flux (mémoire constante) : le fichier communal est réparti par
 * département dans un dossier temporaire, puis substitué à l'ancien.
 */
export async function importStmt(input: Readable, opts: { gzip?: boolean } = {}): Promise<StmtImportResult> {
  const dir = stmtDir();
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.import-${process.pid}-${Date.now()}`);
  await fs.mkdir(tmp, { recursive: true });
  const outs = new Map<string, ReturnType<typeof createWriteStream>>();
  const communes = new Set<string>();
  let header = "";
  let rows = 0;
  let first = "";
  let last = "";
  let national = false;
  const write = async (w: ReturnType<typeof createWriteStream>, s: string) => {
    if (!w.write(s)) await new Promise<void>((r) => w.once("drain", () => r()));
  };
  try {
    for await (const raw of lines(input, !!opts.gzip)) {
      if (!header) {
        if (!HEADER.test(raw)) throw new Error("Colonnes attendues : COMRES;MOISTA;_FREQ_;part_fem;AGE_m;ancien_m");
        header = raw.replace(/^﻿/, "");
        continue;
      }
      if (!raw.trim()) continue;
      const i = raw.indexOf(";");
      const com = raw.slice(0, i).trim();
      const mois = raw.slice(i + 1, i + 7);
      if (!/^\d{6}$/.test(mois)) continue;
      rows++;
      if (!first || mois < first) first = mois;
      if (mois > last) last = mois;
      let key: string;
      if (!com) {
        national = true;
        key = "france";
      } else {
        const code = com.padStart(5, "0");
        communes.add(code);
        key = `dep-${depOfCommune(code)}`;
      }
      let w = outs.get(key);
      if (!w) {
        w = createWriteStream(path.join(tmp, `${key}.csv`));
        outs.set(key, w);
        await write(w, header + "\n");
      }
      await write(w, raw + "\n");
    }
    await Promise.all([...outs.values()].map((w) => new Promise<void>((r, j) => w.end((e?: Error | null) => (e ? j(e) : r())))));
    if (!rows) throw new Error("Aucune ligne lisible");
    const kind = national && !communes.size ? "national" : "communes";
    // Remplacement : le fichier national et les fichiers départementaux sont indépendants.
    for (const f of await fs.readdir(tmp)) await fs.rename(path.join(tmp, f), path.join(dir, f));
    if (kind === "communes") {
      const keep = new Set([...outs.keys()].map((k) => `${k}.csv`));
      for (const f of await fs.readdir(dir)) if (/^dep-.*\.csv$/.test(f) && !keep.has(f)) await fs.rm(path.join(dir, f), { force: true });
    }
    const res: StmtImportResult = { kind, rows, communes: communes.size, first, last };
    await fs.writeFile(path.join(dir, `meta-${kind}.json`), JSON.stringify({ ...res, updatedAt: new Date().toISOString() }));
    return res;
  } finally {
    for (const w of outs.values()) w.destroy();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Fichiers bruts déposés à la main dans data/interne/ : importés au premier usage. */
async function autoImport() {
  const dir = internalDir();
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const f of files.filter((x) => /^RES_(STMT_COM|NAT).*\.csv(\.gz)?$/i.test(x))) {
    const kind = /NAT/i.test(f) ? "national" : "communes";
    const src = path.join(dir, f);
    const st = await fs.stat(src);
    const meta = await fs.stat(path.join(stmtDir(), `meta-${kind}.json`)).catch(() => null);
    if (meta && meta.mtimeMs >= st.mtimeMs) continue;
    await importStmt(createReadStream(src), { gzip: f.endsWith(".gz") });
  }
}

export async function stmtSummary() {
  const out: { communes?: StmtImportResult & { updatedAt: string }; national?: StmtImportResult & { updatedAt: string } } = {};
  for (const k of ["communes", "national"] as const) {
    try {
      out[k] = JSON.parse(await fs.readFile(path.join(stmtDir(), `meta-${k}.json`), "utf8"));
    } catch {
      /* absent */
    }
  }
  return out;
}

export async function removeStmt(kind: "communes" | "national") {
  const dir = stmtDir();
  for (const f of await fs.readdir(dir).catch(() => [] as string[]))
    if ((kind === "national" && /^(france\.csv|meta-national\.json)$/.test(f)) || (kind === "communes" && /^(dep-.*\.csv|meta-communes\.json)$/.test(f))) await fs.rm(path.join(dir, f), { force: true });
}

const num = (s: string | undefined) => {
  if (s == null || s === "") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/** Agrégation mensuelle : effectifs additionnés, caractéristiques pondérées par les effectifs connus. */
class Acc {
  private m = new Map<string, { n: number; wf: number; f: number; wa: number; a: number; wn: number; an: number }>();
  add(mois: string, n: number, fem: number | null, age: number | null, anc: number | null) {
    let x = this.m.get(mois);
    if (!x) this.m.set(mois, (x = { n: 0, wf: 0, f: 0, wa: 0, a: 0, wn: 0, an: 0 }));
    x.n += n;
    if (fem != null) (x.wf += n), (x.f += fem * n);
    if (age != null) (x.wa += n), (x.a += age * n);
    if (anc != null) (x.wn += n), (x.an += anc * n);
  }
  points(): StmtPoint[] {
    return [...this.m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mois, x]) => ({ mois, n: x.n, fem: x.wf ? x.f / x.wf : null, age: x.wa ? x.a / x.wa : null, anc: x.wn ? x.an / x.wn : null }));
  }
}

async function readFile(file: string, keep: (com: string) => boolean, accs: { acc: Acc; test: (com: string) => boolean }[]) {
  try {
    await fs.access(file);
  } catch {
    return false;
  }
  for await (const l of lines(createReadStream(file), false)) {
    if (HEADER.test(l) || !l) continue;
    const c = l.split(";");
    const com = c[0].trim() ? c[0].trim().padStart(5, "0") : "";
    if (!keep(com)) continue;
    const n = num(c[2]);
    if (n == null) continue;
    for (const a of accs) if (a.test(com)) a.acc.add(c[1], n, num(c[3]), num(c[4]), num(c[5]));
  }
  return true;
}

/**
 * Séries mensuelles de la commune (somme des arrondissements pour Paris, Lyon
 * et Marseille), de son département et de la France. null si les fichiers
 * n'ont pas été déposés.
 */
export async function loadStmt(codes: string[], depCode: string): Promise<StmtSeries | null> {
  await autoImport().catch(() => {});
  const dir = stmtDir();
  const want = new Set(codes);
  const com = new Acc();
  const dep = new Acc();
  const found = new Set<string>();
  const ok = await readFile(path.join(dir, `dep-${depCode}.csv`), () => true, [
    { acc: dep, test: () => true },
    {
      acc: com,
      test: (c) => {
        if (!want.has(c)) return false;
        found.add(c);
        return true;
      },
    },
  ]);
  if (!ok) return null;
  const fr = new Acc();
  await readFile(path.join(dir, "france.csv"), () => true, [{ acc: fr, test: () => true }]);
  return { commune: com.points(), departement: dep.points(), france: fr.points(), codes: [...found] };
}
