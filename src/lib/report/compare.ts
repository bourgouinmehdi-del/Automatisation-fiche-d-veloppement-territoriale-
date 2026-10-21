import { fmtValue } from "../format";
import type { Block, ChartSpec, Report } from "../types";

/**
 * Mode comparaison : l'essentiel de 2 ou 3 fiches commune, aligné ligne à ligne
 * (chiffres clés, profil, vote, présence militante, bureaux prioritaires, synthèse).
 */

/** Indicateurs comparés (valeur de la commune, valeur du département en petit). */
const PROFIL: { id: string; alt?: string; label: string }[] = [
  { id: "taux_pauvrete", label: "Sous le seuil de pauvreté" },
  { id: "revenu_median", label: "Revenu médian par mois" },
  { id: "taux_chomage_rp", label: "Chômage" },
  { id: "part_locataires_hlm", label: "Logement social (HLM)" },
  { id: "part_moins_25", alt: "part_moins_30", label: "Moins de 25 ans" },
  { id: "part_65_plus", alt: "part_60_plus", label: "Plus de 65 ans" },
  { id: "part_ouvriers", label: "Ouvriers" },
  { id: "part_cadres", label: "Cadres" },
  { id: "part_sans_diplome", label: "Sans diplôme (ou brevet)" },
  { id: "part_menages_sans_voiture", label: "Foyers sans voiture" },
  { id: "medecins_10k", label: "Médecins généralistes pour 10 000 habitants" },
];

export interface CompareCol {
  id: string;
  nom: string;
  departement: string;
  version: number;
  updatedAt: string;
  glance: Record<string, { value: string; detail?: string }>;
  profil: Record<string, { value: string; dep?: string }>;
  synth: string[];
  chart: ChartSpec | null;
  presence: Extract<Block, { type: "presence" }> | null;
  bureaux: { bv: string; lieu: string; lfi: string; abst: string }[];
}

export function compareCol(r: Report): CompareCol {
  const fiche = r.sections.find((s) => s.id === "LFI");
  const blocks = fiche?.blocks ?? [];
  const glance: CompareCol["glance"] = {};
  for (const b of blocks) if (b.type === "glance") for (const i of b.items) glance[i.label] = { value: i.value, detail: i.detail };
  const ind = (id: string, level: "commune" | "departement") => r.indicators.find((i) => i.id === id && i.geo.level === level && i.value != null);
  const profil: CompareCol["profil"] = {};
  for (const p of PROFIL) {
    const id = ind(p.id, "commune") ? p.id : p.alt && ind(p.alt, "commune") ? p.alt : p.id;
    const c = ind(id, "commune");
    if (!c) continue;
    const d = ind(id, "departement");
    profil[p.label] = { value: fmtValue(c.value!, c.unit), dep: d ? fmtValue(d.value!, d.unit) : undefined };
  }
  // Synthèse : la première liste sans titre de la fiche (points clés en tête).
  const synthBlock = blocks.find((b) => b.type === "list" && !b.title) as Extract<Block, { type: "list" }> | undefined;
  const prio = r.tables.find((t) => t.id === "lfi_bureaux_prio");
  const bureaux = (prio?.rows ?? [])
    .filter((x) => x.bv && !/ensemble/i.test(String(x.libelle ?? "")) && !/ensemble/i.test(String(x.bv)))
    .slice(0, 4)
    .map((x) => ({ bv: String(x.bv), lieu: String(x.libelle ?? ""), lfi: String(x.lfi ?? ""), abst: String(x.abstn ?? "") }));
  return {
    id: r.id,
    nom: r.commune.nom,
    departement: `${r.commune.departement.nom} (${r.commune.departement.code})`,
    version: r.version,
    updatedAt: r.updatedAt,
    glance,
    profil,
    synth: synthBlock?.items.map((i) => i.text) ?? [],
    chart: r.charts.find((c) => c.id === "lfi_chart_eu24") ?? null,
    presence: (blocks.find((b) => b.type === "presence") as Extract<Block, { type: "presence" }> | undefined) ?? null,
    bureaux,
  };
}
