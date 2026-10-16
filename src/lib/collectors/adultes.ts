import type { TrackedHttp } from "./context";
import { QUARTIERS_SOURCES } from "./quartiers";
import { zipCsvRows } from "./zip";
import { cachedExtract, heavyLane } from "../runtime";

/**
 * Adultes de nationalité française, par IRIS, pour un département : base de
 * l'estimation de la non-inscription sur les listes électorales.
 *
 * Source : INSEE, recensement, « Évolution et structure de la population »
 * à l'IRIS (fichier national, déjà utilisé pour les quartiers).
 *  - adultes = population − moins de 18 ans (0-2, 3-5, 6-10, 11-17 ans) ;
 *  - adultes français ≈ adultes × part des Français dans la population
 *    (la part par âge n'est pas publiée à l'IRIS : approximation).
 */

export interface AdultesIris {
  iris: string;
  com: string;
  pop: number;
  adultes: number;
  adultesFr: number;
  /** 18-24 ans (souvent étudiants inscrits chez leurs parents), si publié. */
  jeunes?: number | null;
}

export interface AdultesDep {
  rows: AdultesIris[];
  /** Millésime du recensement (ex. « 2021 »). */
  annee: string | null;
  /** La nationalité était disponible (sinon adultesFr = adultes). */
  nationalite: boolean;
  url: string;
  retrievedAt: string;
}

const num = (v: string | undefined) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** Lecture d'une ligne IRIS (colonnes « P21_POP », « P21_POP0002 »…). */
export function adultesOf(r: Record<string, string>): { pop: number; adultes: number; fr: number | null; jeunes: number | null; annee: string | null } | null {
  const k = (re: RegExp) => Object.keys(r).find((c) => re.test(c));
  const v = (re: RegExp) => {
    const c = k(re);
    return c ? num(r[c]) : null;
  };
  const pop = v(/^P\d\d_POP$/);
  if (pop == null) return null;
  const minors = [/^P\d\d_POP0002$/, /^P\d\d_POP0305$/, /^P\d\d_POP0610$/, /^P\d\d_POP1117$/].map(v);
  // Tranches fines absentes : 0-14 ans + 3/5 des 15-19 ans.
  const under = minors.every((x) => x != null) ? minors.reduce((s, x) => s + x!, 0) : (v(/^P\d\d_POP0014$/) ?? 0) + 0.6 * (v(/^P\d\d_POP1519$/) ?? 0);
  const fr = v(/^P\d\d_POP_FR$/);
  const annee = k(/^P\d\d_POP$/)?.match(/^P(\d\d)/)?.[1] ?? null;
  return { pop, adultes: Math.max(0, pop - under), fr, jeunes: v(/^P\d\d_POP1824$/), annee: annee ? `20${annee}` : null };
}

export function collectAdultes(http: TrackedHttp, dep: string): Promise<AdultesDep> {
  return cachedExtract(
    `adultes2|${dep}`,
    24 * 60,
    () =>
      heavyLane.run(async () => {
        const url = QUARTIERS_SOURCES.irisPop;
        const f = await http.file(url, { timeoutMs: 900000 });
        const depOf = (com: string) => (/^97/.test(com) ? com.slice(0, 3) : com.slice(0, 2));
        const { rows } = await zipCsvRows(
          f.data,
          (n) => /\.csv$/i.test(n) && !/meta|dico|var/i.test(n),
          (r) => depOf((r.COM ?? r.IRIS ?? "").padStart(5, "0")) === dep,
          (line) => line.includes(`;${dep}`) || line.startsWith(dep) || line.includes(`"${dep}`),
        );
        let annee: string | null = null;
        let nationalite = false;
        const out: AdultesIris[] = [];
        for (const r of rows) {
          const a = adultesOf(r);
          if (!a) continue;
          annee ??= a.annee;
          if (a.fr != null) nationalite = true;
          const share = a.fr != null && a.pop > 0 ? a.fr / a.pop : 1;
          out.push({ iris: String(r.IRIS ?? ""), com: String(r.COM ?? String(r.IRIS ?? "").slice(0, 5)).padStart(5, "0"), pop: a.pop, adultes: a.adultes, adultesFr: a.adultes * share, jeunes: a.jeunes });
        }
        return { rows: out, annee, nationalite, url, retrievedAt: f.retrievedAt };
      }),
    (v) => v.rows.length > 0,
  );
}
