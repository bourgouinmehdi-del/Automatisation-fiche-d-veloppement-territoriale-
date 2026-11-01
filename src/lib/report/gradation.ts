/**
 * Échelle graduée des comparaisons (retour sur Montargis : « nettement plus » pour 11 % contre 8 % était
 * trop fort). Une seule échelle pour toute la fiche, de « autant » à « dix fois plus » :
 *
 *   niveau 0  autant / au même niveau
 *   niveau 1  à peine plus / à peine moins
 *   niveau 2  un peu plus / un peu moins
 *   niveau 3  plus / moins
 *   niveau 4  nettement plus / nettement moins
 *   niveau 5  beaucoup plus / beaucoup moins
 *   niveau 6  bien plus / bien moins
 *   et, pour les écarts multiplicatifs : près de deux fois, deux fois, deux fois et demie, trois fois… dix fois.
 *
 * Pour des parts (en %), deux lectures — en points et en proportion — dont on prend la moyenne (arrondie
 * vers le bas) : 11 % contre 8 % fait 3 points (niveau 3) et 40 % de plus (niveau 4), donc « plus » ;
 * 42 % contre 33 % fait 9 points (5) et 27 % de plus (3), donc « nettement plus ». Pour des taux ou des
 * nombres (médecins pour 10 000 habitants), la proportion seule.
 */
export type Ecart = { dir: "plus" | "moins" | "autant"; level: number; words: string; net: boolean };

const ADV = ["autant", "à peine", "un peu", "", "nettement", "beaucoup", "bien"];
const POINTS = [1, 2, 3, 5, 8, 12]; // seuils en points : < 1 → 0 ; 1–2 → 1 ; … ; ≥ 12 → 6
const RATIO = [0.05, 0.1, 0.2, 0.3, 0.5, 0.8]; // écart relatif : < 5 % → 0 ; … ; ≥ 80 % → 6
const lvl = (v: number, steps: number[]) => steps.findIndex((s) => v < s) === -1 ? steps.length : steps.findIndex((s) => v < s);
const NOMBRES = ["", "", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix"];

/** « deux fois plus », « près de deux fois moins »… pour un rapport ≥ 1,8 (ou ≤ 1/1,8). */
function fois(r: number, dir: "plus" | "moins"): string | null {
  const k = r >= 1 ? r : 1 / r;
  if (k < 1.8) return null;
  if (k < 1.95) return `près de deux fois ${dir}`;
  if (k < 2.35) return `deux fois ${dir}`;
  if (k < 2.75) return `deux fois et demie ${dir}`;
  const n = Math.min(10, Math.round(k));
  return `${NOMBRES[n] || n} fois ${dir}`;
}

function build(level: number, dir: "plus" | "moins", r: number, more: string, less: string): Ecart {
  if (level === 0) return { dir: "autant", level: 0, words: "autant", net: false };
  const w = dir === "plus" ? more : less;
  // Les multiplicateurs seulement pour les grands écarts (niveau 5 et plus).
  const f = level >= 5 ? fois(r, dir) : null;
  return { dir, level, words: f ? f.replace(/ (plus|moins)$/, ` ${w}`) : `${ADV[level]} ${w}`.trim(), net: level >= 4 };
}

/** Deux parts en % (vote, abstention, pauvreté) : niveau le plus bas entre points et proportion. */
export function ecartParts(c: number, d: number, more = "plus", less = "moins"): Ecart {
  const diff = c - d;
  const r = d ? c / d : c ? 9 : 1;
  const lp = lvl(Math.abs(diff), POINTS);
  const lr = lvl(Math.abs(r - 1), RATIO);
  // Moyenne des deux lectures, arrondie vers le bas ; jamais plus d'un cran au-dessus de la plus prudente.
  const level = Math.min(Math.floor((lp + lr) / 2), Math.min(lp, lr) + 1);
  return build(level, diff >= 0 ? "plus" : "moins", r, more, less);
}

/** Deux taux ou nombres (médecins pour 10 000 habitants) : proportion seule. */
export function ecartRatio(c: number, d: number, more = "plus", less = "moins"): Ecart {
  if (!d) return { dir: c ? "plus" : "autant", level: c ? 6 : 0, words: c ? more : "autant", net: !!c };
  const r = c / d;
  const level = lvl(Math.abs(r - 1), RATIO);
  return build(level, r >= 1 ? "plus" : "moins", r, more, less);
}

/** Toutes les formulations possibles (documentation, tests). */
export const FORMULATIONS = [
  "autant",
  ...["plus", "moins"].flatMap((d) => [...ADV.slice(1).map((a) => `${a} ${d}`.trim()), ...["près de deux fois", "deux fois", "deux fois et demie", "trois fois", "quatre fois", "cinq fois"].map((x) => `${x} ${d}`)]),
];
