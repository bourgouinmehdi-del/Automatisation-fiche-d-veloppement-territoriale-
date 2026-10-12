/**
 * Paris, Lyon et Marseille (loi « PLM ») : les arrondissements municipaux ont
 * leur propre code INSEE (75112 pour Paris 12e), mais les résultats électoraux
 * et une partie des fichiers nationaux sont publiés au code de la ville
 * (75056, 69123, 13055). Ce module fait le lien.
 */

const CITIES = [
  { parent: "75056", prefix: "751", nom: "Paris" },
  { parent: "69123", prefix: "6938", nom: "Lyon" },
  { parent: "13055", prefix: "132", nom: "Marseille" },
];

export interface PlmInfo {
  /** Code INSEE de la ville (75056…). */
  parent: string;
  /** Numéro d'arrondissement (12 pour Paris 12e). */
  arr: number;
  ville: string;
}

/** Arrondissement municipal de Paris, Lyon ou Marseille ; null pour une commune ordinaire. */
export function plmInfo(code: string): PlmInfo | null {
  for (const c of CITIES) {
    if (!code.startsWith(c.prefix) || code === c.parent) continue;
    const arr = Number(code.slice(c.prefix.length));
    if (Number.isInteger(arr) && arr >= 1 && arr <= 20) return { parent: c.parent, arr, ville: c.nom };
  }
  return null;
}

/**
 * Numéro de bureau dans un arrondissement, ramené à la forme « AABB » (1201 pour
 * le bureau 1 du 12e). Accepte « 1201 », « 75056_1201 », « 12-01 » et la
 * numérotation locale « 01 » (sauf en mode strict : dans un fichier publié au
 * code de la ville, un numéro court ne dit pas son arrondissement). Renvoie null
 * si le bureau appartient à un autre arrondissement.
 */
export function plmBvKey(raw: unknown, arr: number, strict = false): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const last = s.split(/[_\s]/).pop() ?? s;
  const pair = last.match(/^(\d{1,2})[-.](\d{1,3})$/);
  if (pair) return Number(pair[1]) === arr ? String(arr * 100 + Number(pair[2])) : null;
  const n = Number(last.replace(/\D/g, ""));
  if (!Number.isFinite(n) || !last.replace(/\D/g, "")) return null;
  if (n >= 100) return Math.floor(n / 100) === arr ? String(n) : null;
  return strict ? null : String(arr * 100 + n);
}
