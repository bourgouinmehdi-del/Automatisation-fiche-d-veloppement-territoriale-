/**
 * Indice d'accès aux services (référence = 100) dit en mots et en couleur : la fiche n'affiche pas le
 * chiffre, seulement le niveau.
 */
export interface NiveauAcces {
  txt: string;
  /** Couleur du texte et du fond (pastille). */
  fg: string;
  bg: string;
  /** Couleur pour du texte seul (Word). */
  ink: string;
  /** Position sur la jauge (0 à 1). */
  pos: number;
}

export function niveauAcces(v: number): NiveauAcces {
  const pos = Math.max(0, Math.min(1, (Math.log2(Math.max(v, 1) / 100) + 1) / 2));
  if (v < 70) return { txt: "Nettement moins bon", fg: "#ffffff", bg: "#c0392b", ink: "#c0392b", pos };
  if (v < 90) return { txt: "Un peu moins bon", fg: "#5c2a00", bg: "#f5b041", ink: "#b9770e", pos };
  if (v <= 110) return { txt: "Comme en moyenne", fg: "#2f2e2b", bg: "#e5e4df", ink: "#52514e", pos };
  if (v <= 130) return { txt: "Un peu meilleur", fg: "#0f4d2f", bg: "#a9dfbf", ink: "#239b56", pos };
  return { txt: "Nettement meilleur", fg: "#ffffff", bg: "#1e8449", ink: "#1e8449", pos };
}
