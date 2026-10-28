import { plmInfo } from "./plm";
import type { TrackedHttp } from "./context";
import { cachedExtract, heavyLane } from "../runtime";
import { clean, findResource, num, tabular } from "./datagouv";
import { filterCsvFile, normDep } from "./elections";

/**
 * Contexte municipal : résultats des élections municipales 2026 (1er et 2nd
 * tours, ministère de l'Intérieur) et maire en fonction (Répertoire national
 * des élus). Données publiques agrégées par liste ; le nom du maire est une
 * information publique relative à un mandat électif.
 *
 * Format relevé en octobre 2026 (résultats par commune) : colonnes
 * « Code commune », « Inscrits », « Votants », « Exprimés », puis par liste N :
 * « Nom candidat N », « Prénom candidat N », « Nuance liste N »,
 * « Libellé de liste N », « Voix N », « Elu N », « Sièges au CM N ».
 */

export const MUNICIPALES = {
  year: "2026",
  t1: { dataset: "elections-municipales-2026-resultats-du-premier-tour", fallback: { id: "4feeef01-24f7-4d5a-914f-8aa806f31ec2" } },
  t2: { dataset: "elections-municipales-2026-resultats-du-second-tour", fallback: { id: "6ff67a28-01bf-459e-beca-dd7aa8132dc1" } },
  rne: { dataset: "repertoire-national-des-elus-1", fallback: { id: "2876a346-d50c-4911-934e-19ee07b0e503" } },
};

/** Libellés des nuances de listes (municipales). */
export const NUANCES: Record<string, string> = {
  LEXG: "Extrême gauche",
  LFI: "La France insoumise",
  LCOM: "Parti communiste",
  LSOC: "Parti socialiste",
  LUG: "Union de la gauche",
  LDVG: "Divers gauche",
  LECO: "Écologistes",
  LVEC: "Les Écologistes",
  LREG: "Régionalistes",
  LDIV: "Divers",
  LGJ: "Gilets jaunes",
  LREN: "Renaissance",
  LENS: "Ensemble",
  LMDM: "MoDem",
  LHOR: "Horizons",
  LUDI: "UDI",
  LUC: "Union du centre",
  LDVC: "Divers centre",
  LLR: "Les Républicains",
  LUD: "Union de la droite",
  LDVD: "Divers droite",
  LDSV: "Droite souverainiste",
  LRN: "Rassemblement national",
  LUXD: "Union de l'extrême droite",
  LREC: "Reconquête",
  LEXD: "Extrême droite",
  LNC: "Non communiqué",
};

/** Famille politique d'une nuance (gauche / centre / droite / extrême droite / divers). */
export function nuanceFamily(code: string): "gauche" | "centre" | "droite" | "extreme_droite" | "divers" {
  if (/^L(EXG|FI|COM|SOC|UG|DVG|ECO|VEC)$/.test(code)) return "gauche";
  if (/^L(REN|ENS|MDM|HOR|UDI|UC|DVC)$/.test(code)) return "centre";
  if (/^L(LR|UD|DVD|DSV)$/.test(code)) return "droite";
  if (/^L(RN|UXD|REC|EXD)$/.test(code)) return "extreme_droite";
  return "divers";
}

export interface MunicipalList {
  tete: string;
  nuance: string;
  libelle: string;
  voix: number;
  pctExprimes: number;
  sieges: number | null;
  elu: boolean;
}

export interface MunicipalRound {
  tour: 1 | 2;
  inscrits: number;
  votants: number;
  exprimes: number;
  listes: MunicipalList[];
}

export interface MunicipalResult {
  code: string;
  rounds: MunicipalRound[];
  /** Liste majoritaire au conseil municipal (tour décisif). */
  majorite: MunicipalList | null;
  maire: { nom: string; prenom: string; debutFonction: string | null } | null;
  /** Arrondissement de Paris, Lyon ou Marseille : résultats de la ville entière (nom de la ville). */
  ville?: string;
  urls: string[];
  retrievedAt: string;
}

/**
 * Variante « 2022 » des fichiers du ministère : seul le premier bloc de liste
 * porte des en-têtes, les suivants arrivent sans nom (`__parsed_extra` de
 * Papa Parse). On les renomme « <en-tête> 2 », « <en-tête> 3 »…
 */
export function expandListBlocks(rows: Record<string, unknown>[], fields: string[]): Record<string, unknown>[] {
  const start = fields.findIndex((f) => /^(n(°|um[ée]ro)\s*(de\s*)?panneau|nuance)/i.test(f.trim()));
  if (start < 0) return rows;
  const group = fields.slice(start);
  const base = (f: string) => f.replace(/[ _]\d+$/, "").trim();
  return rows.map((r) => {
    const extra = r.__parsed_extra as unknown[] | undefined;
    if (!Array.isArray(extra) || !extra.length) return r;
    const o: Record<string, unknown> = { ...r };
    delete o.__parsed_extra;
    for (const f of group) if (!/[ _]\d+$/.test(f)) o[`${base(f)} 1`] = r[f];
    for (let k = 0; (k + 1) * group.length <= extra.length; k++) group.forEach((f, j) => (o[`${base(f)} ${k + 2}`] = extra[k * group.length + j]));
    return o;
  });
}

/** Lit une ligne « large » (blocs répétés par liste) en résultats structurés. */
export function parseMunicipalRow(r: Record<string, unknown>, tour: 1 | 2): MunicipalRound | null {
  const keys = Object.keys(r);
  const k = (re: RegExp) => keys.find((c) => re.test(c.trim()));
  const ins = num(r[k(/^inscrits$/i) ?? ""]);
  const exp = num(r[k(/^exprim[ée]s$/i) ?? ""]);
  if (ins == null || exp == null) return null;
  // Blocs par suffixe numérique (« Voix 3 », « Voix_3 ») ; colonnes sans suffixe = bloc 1.
  const blocks = new Map<string, Map<string, unknown>>();
  for (const key of keys) {
    const m = key.trim().match(/^(.*?)[ _](\d+)$/);
    const [b, id] = m ? [m[1], m[2]] : [key.trim(), "1"];
    if (!blocks.has(id)) blocks.set(id, new Map());
    if (!blocks.get(id)!.has(b)) blocks.get(id)!.set(b, r[key]);
  }
  const field = (blk: Map<string, unknown>, re: RegExp, not?: RegExp) => {
    for (const [b, v] of blk) if (re.test(b) && !(not && not.test(b))) return String(v ?? "").trim();
    return "";
  };
  const listes: MunicipalList[] = [];
  for (const blk of blocks.values()) {
    const voix = num(field(blk, /^voix$/i));
    if (voix == null) continue;
    const nom = field(blk, /^nom/i, /nuance|^nom (de (la )?)?liste/i) || field(blk, /^nom.*t[êe]te|t[êe]te de liste.*nom/i);
    const prenom = field(blk, /^pr[ée]nom/i) || field(blk, /pr[ée]nom.*t[êe]te|t[êe]te de liste.*pr[ée]nom/i);
    // 2020 : « Liste » et « Sièges / Elu » ; 2026 : « Libellé de liste », « Sièges au CM ».
    const lib = field(blk, /^libell[ée] (de )?(la )?liste$/i) || field(blk, /^libell[ée].*(abr|liste)/i) || field(blk, /^liste$/i);
    if (!nom && !lib) continue;
    listes.push({
      tete: [prenom, nom].filter(Boolean).join(" "),
      nuance: field(blk, /nuance/i),
      libelle: lib,
      voix,
      pctExprimes: exp ? (100 * voix) / exp : 0,
      sieges: num(field(blk, /si[èe]ges.*(cm|conseil municipal)|^si[èe]ges$/i) || field(blk, /^si[èe]ges\s*\/\s*[ée]lu/i)),
      elu: /^(oui|elu|élu|1|true)$/i.test(field(blk, /^[ée]lu/i)),
    });
  }
  listes.sort((a, b) => b.voix - a.voix);
  return { tour, inscrits: ins, votants: num(r[k(/^votants$/i) ?? ""]) ?? 0, exprimes: exp, listes };
}

/** Même liste d'un tour à l'autre : tête de liste, sinon libellé (et nuance). */
export const sameList = (a: MunicipalList, b: MunicipalList) =>
  (!!a.tete && a.tete === b.tete) || (!!a.libelle && a.libelle.toLowerCase() === b.libelle.toLowerCase() && (!a.nuance || !b.nuance || a.nuance === b.nuance));

/** Liste qui détient la majorité au conseil municipal (tour décisif). */
export function majorityList(rounds: MunicipalRound[]): MunicipalList | null {
  const last = [...rounds].sort((a, b) => b.tour - a.tour).find((r) => r.listes.some((l) => (l.sieges ?? 0) > 0)) ?? rounds[rounds.length - 1];
  if (!last?.listes.length) return null;
  return [...last.listes].sort((a, b) => (b.sieges ?? 0) - (a.sieges ?? 0) || b.voix - a.voix)[0];
}

/** Lignes d'un département extraites du fichier national (repli), mémorisées par tour. */

/**
 * Lignes « résultats par commune » d'un tour : API tabulaire si la ressource y est
 * indexée, sinon fichier CSV national lu en flux (seules les lignes du
 * département sont conservées). Le fichier du 1er tour 2026 n'est plus servi
 * par l'API tabulaire (HTTP 410), d'où ce repli.
 */
async function roundRows(http: TrackedHttp, which: "t1" | "t2", dep: string, commune?: string): Promise<{ rows: Record<string, unknown>[]; url: string; retrievedAt: string }> {
  const cfg = MUNICIPALES[which];
  const res = await findResource(http, cfg.dataset, /^Municipales 2026 - R[ée]sultats - Communes/i, cfg.fallback);
  if (!res) throw new Error(`Résultats municipaux (${which}) introuvables`);
  try {
    const t = await tabular(http, res.id, [commune ? { col: "Code commune", op: "exact" as const, value: commune } : { col: "Code département", op: "exact" as const, value: dep }], 20);
    if (!t.rows.length && !commune && dep.startsWith("0")) {
      const t2 = await tabular(http, res.id, [{ col: "Code département", op: "exact", value: dep.slice(1) }], 20);
      if (t2.rows.length) return t2;
    }
    if (t.rows.length) return t;
    throw new Error("aucune ligne dans l'API tabulaire");
  } catch {
    if (!res.url) throw new Error(`Résultats municipaux (${which}) : ressource sans URL de téléchargement`);
    const url = res.url;
    const { rows, retrievedAt } = await cachedExtract(`municipales|${which}|${dep}`, 24 * 7, () =>
      heavyLane.run(async () => {
        http.notes.push(`municipales ${which} : lecture du fichier national`);
        const f = await http.file(url, { timeoutMs: 600000, retries: 1 });
        const x = await filterCsvFile(f.data, dep, `municipales ${which}`);
        return { rows: expandListBlocks(x.rows, x.fields), retrievedAt: f.retrievedAt };
      }),
    );
    const code = (r: Record<string, unknown>) => clean(r["Code commune"]).padStart(5, "0");
    return { rows: commune ? rows.filter((r) => code(r) === commune) : rows, url: res.url, retrievedAt };
  }
}

export async function collectMunicipales(http: TrackedHttp, codeInsee: string, dep = codeInsee.slice(0, codeInsee.startsWith("97") ? 3 : 2)): Promise<MunicipalResult> {
  const plm = plmInfo(codeInsee);
  if (!plm) return collectMunicipalesCommune(http, codeInsee, dep);
  // Arrondissement : résultats propres s'ils sont publiés, sinon ceux de la ville.
  try {
    return await collectMunicipalesCommune(http, codeInsee, dep);
  } catch {
    const v = await collectMunicipalesCommune(http, plm.parent, dep);
    http.notes.push(`Résultats municipaux de l'arrondissement non publiés dans le fichier : résultats de ${plm.ville}`);
    return { ...v, ville: plm.ville };
  }
}

async function collectMunicipalesCommune(http: TrackedHttp, codeInsee: string, dep: string): Promise<MunicipalResult> {
  const rounds: MunicipalRound[] = [];
  const urls: string[] = [];
  let retrievedAt = "";
  const errors: string[] = [];
  for (const [which, tour] of [["t1", 1], ["t2", 2]] as const) {
    try {
      const t = await roundRows(http, which, dep, codeInsee);
      urls.push(t.url);
      retrievedAt ||= t.retrievedAt;
      const row = t.rows[0];
      const parsed = row ? parseMunicipalRow(row, tour) : null;
      if (parsed?.listes.length) rounds.push(parsed);
    } catch (e) {
      errors.push(`tour ${tour} : ${e instanceof Error ? e.message : e}`);
    }
  }
  if (errors.length) http.notes.push(...errors);
  let maire: MunicipalResult["maire"] = null;
  try {
    const res = await findResource(http, MUNICIPALES.rne.dataset, /maire/i, MUNICIPALES.rne.fallback);
    if (res) {
      const t = await tabular(http, res.id, [{ col: "Code de la commune", op: "exact", value: codeInsee }], 2);
      urls.push(t.url);
      const r = t.rows[0];
      if (r) maire = { nom: clean(r["Nom de l'élu"]), prenom: clean(r["Prénom de l'élu"]), debutFonction: r["Date de début de la fonction"] ? clean(r["Date de début de la fonction"]) : null };
    }
  } catch {
    /* le maire reste inconnu */
  }
  if (!rounds.length && !maire) throw new Error(errors.length === 2 ? errors.join(" ; ") : "Aucun résultat municipal 2026 pour la commune (communes de moins de 1 000 habitants : scrutin sans listes)");
  if (errors.length) http.partial = true;
  return { code: codeInsee, rounds, majorite: majorityList(rounds), maire, urls, retrievedAt: retrievedAt || new Date().toISOString() };
}

/** Nuance de la liste majoritaire pour toutes les communes d'un département (mode département). */
export async function collectMunicipalesDepartement(http: TrackedHttp, dep: string): Promise<{ byCommune: Map<string, { nuance: string; tete: string; pct: number }>; url: string; retrievedAt: string }> {
  const byCommune = new Map<string, { nuance: string; tete: string; pct: number }>();
  const rows = new Map<string, MunicipalRound[]>();
  let url = "";
  let retrievedAt = "";
  for (const [which, tour] of [["t1", 1], ["t2", 2]] as const) {
    let t;
    try {
      t = await roundRows(http, which, dep);
    } catch (e) {
      if (tour === 1) throw e;
      continue;
    }
    url ||= t.url;
    retrievedAt ||= t.retrievedAt;
    for (const r of t.rows) {
      const code = clean(r["Code commune"]).padStart(5, "0");
      const p = parseMunicipalRow(r, tour);
      if (!p) continue;
      if (!rows.has(code)) rows.set(code, []);
      rows.get(code)!.push(p);
    }
  }
  for (const [code, rs] of rows) {
    const m = majorityList(rs);
    if (m) byCommune.set(code, { nuance: m.nuance, tete: m.tete, pct: m.pctExprimes });
  }
  return { byCommune, url, retrievedAt };
}

/**
 * Municipales 2020, 1er tour (15 mars 2020), communes de 1 000 habitants et plus : fichier national du
 * ministère de l'Intérieur (texte à tabulations, un bloc de colonnes par liste), lu en flux et filtré
 * sur le département. Sert à comparer la présence et le score de LFI avec 2026.
 */
export const MUNICIPALES_2020 = { dataset: "elections-municipales-2020-resultats", resource: /1000.*(et.)?plus/i };

/** Code INSEE d'une ligne des fichiers 2020 (« Code du département » + « Code de la commune » sur 3 chiffres). */
export function code2020(r: Record<string, unknown>): string {
  const keys = Object.keys(r);
  const kd = keys.find((k) => /^code (du )?d[ée]partement$/i.test(k.trim()));
  const kc = keys.find((k) => /^code (de la )?commune$/i.test(k.trim()));
  if (!kc) return "";
  const raw = String(r[kc] ?? "").trim();
  if (/^\d[\dAB]\d{3}$/i.test(raw)) return raw.toUpperCase();
  const d = kd ? normDep(r[kd]) : "";
  return d ? d + raw.padStart(3, "0").slice(d.length === 3 ? -2 : -3) : raw;
}

export async function collectMunicipales2020(http: TrackedHttp, codeInsee: string, dep = codeInsee.slice(0, codeInsee.startsWith("97") ? 3 : 2)): Promise<{ round: MunicipalRound; url: string; retrievedAt: string }> {
  const res = await findResource(http, MUNICIPALES_2020.dataset, MUNICIPALES_2020.resource);
  if (!res?.url) throw new Error("Municipales 2020 : fichier des communes de 1 000 habitants et plus introuvable");
  const url = res.url;
  const { rows, retrievedAt } = await cachedExtract(`municipales2020|t1|${dep}`, 24 * 30, () =>
    heavyLane.run(async () => {
      http.notes.push("municipales 2020 : lecture du fichier national");
      const f = await http.file(url, { timeoutMs: 600000, retries: 1 });
      const x = await filterCsvFile(f.data, dep, "municipales 2020");
      return { rows: expandListBlocks(x.rows, x.fields), retrievedAt: f.retrievedAt };
    }),
  );
  const row = rows.find((r) => code2020(r) === codeInsee);
  const round = row ? parseMunicipalRow(row, 1) : null;
  if (!round?.listes.length) throw new Error("Pas de résultat municipal 2020 par liste pour la commune (moins de 1 000 habitants en 2020 ?)");
  return { round, url, retrievedAt };
}
