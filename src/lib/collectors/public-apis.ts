import type { TrackedHttp } from "./context";

/**
 * Connecteurs vers des API publiques « simples » (REST / Opendatasoft) :
 * Géorisques, Annuaire de l'éducation, SNCF Open Data, Recherche d'entreprises.
 * Les champs sont lus de façon tolérante (plusieurs noms possibles) car ces
 * schémas évoluent ; un champ absent produit une valeur manquante, jamais
 * une valeur par défaut chiffrée.
 */

const pick = (o: Record<string, unknown> | undefined, ...keys: string[]) => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] != null && o[k] !== "") return o[k];
  return undefined;
};
const str = (v: unknown) => (v == null ? "" : String(v));
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/* ============================================================ Géorisques */

export const GEORISQUES = "https://georisques.gouv.fr/api/v1";

export interface RisquesResult {
  risques: string[];
  catnat: { libelle: string; debut: string; fin: string; publication: string }[];
  sismicite: string | null;
  radon: string | null;
  icpe: { nom: string; regime: string; seveso: string; lon: number | null; lat: number | null }[];
  urls: string[];
  retrievedAt: string;
}

export async function collectRisques(http: TrackedHttp, codeInsee: string): Promise<RisquesResult> {
  const out: RisquesResult = { risques: [], catnat: [], sismicite: null, radon: null, icpe: [], urls: [], retrievedAt: "" };
  type D<T> = { data?: T[]; next?: string | null };

  const u1 = `${GEORISQUES}/gaspar/risques?code_insee=${codeInsee}`;
  const r1 = await http.json<D<{ risques_detail?: { libelle_risque_long?: string }[] }>>(u1);
  out.urls.push(u1);
  out.retrievedAt = r1.retrievedAt;
  for (const d of r1.data?.data ?? []) for (const x of d.risques_detail ?? []) if (x.libelle_risque_long) out.risques.push(x.libelle_risque_long);
  out.risques = [...new Set(out.risques)];

  let u2: string | null = `${GEORISQUES}/gaspar/catnat?code_insee=${codeInsee}&page=1&page_size=100`;
  let guard = 0;
  while (u2 && guard++ < 10) {
    const r2: { data: D<Record<string, unknown>> | null } = await http.json<D<Record<string, unknown>>>(u2);
    out.urls.push(u2);
    for (const c of r2.data?.data ?? [])
      out.catnat.push({
        libelle: str(pick(c, "libelle_risque_jo", "libelle_risque")),
        debut: str(pick(c, "date_debut_evt")),
        fin: str(pick(c, "date_fin_evt")),
        publication: str(pick(c, "date_publication_arrete", "date_publication_jo")),
      });
    u2 = r2.data?.next ?? null;
  }

  try {
    const u3 = `${GEORISQUES}/zonage_sismique?code_insee=${codeInsee}`;
    const r3 = await http.json<D<Record<string, unknown>>>(u3, { retries: 1 });
    out.urls.push(u3);
    out.sismicite = str(pick(r3.data?.data?.[0], "zone_sismicite", "code_zone")) || null;
  } catch {
    http.partial = true;
  }
  try {
    const u4 = `${GEORISQUES}/radon?code_insee=${codeInsee}`;
    const r4 = await http.json<D<Record<string, unknown>>>(u4, { retries: 1 });
    out.urls.push(u4);
    const c = str(pick(r4.data?.data?.[0], "classe_potentiel"));
    out.radon = c ? `Catégorie ${c} (sur 3)` : null;
  } catch {
    http.partial = true;
  }
  try {
    const u5 = `${GEORISQUES}/installations_classees?code_insee=${codeInsee}&page_size=100`;
    const r5 = await http.json<D<Record<string, unknown>>>(u5, { retries: 1 });
    out.urls.push(u5);
    for (const i of r5.data?.data ?? [])
      out.icpe.push({
        nom: str(pick(i, "raisonSociale", "raison_sociale", "nomEts", "nom")),
        regime: str(pick(i, "regime", "regimeVigueur", "libelleRegime")),
        seveso: str(pick(i, "statutSeveso", "statut_seveso", "libelleStatutSeveso")),
        lon: num(pick(i, "longitude", "x")),
        lat: num(pick(i, "latitude", "y")),
      });
  } catch {
    http.partial = true;
  }
  return out;
}

/* ============================================ Annuaire de l'éducation */

export const EDUCATION =
  "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-annuaire-education/records";

export interface School {
  id: string;
  nom: string;
  type: string;
  statut: string;
  eleves: number | null;
  priorite: string;
  lon: number | null;
  lat: number | null;
}

export async function collectSchools(http: TrackedHttp, codeInsee: string) {
  const schools: School[] = [];
  let offset = 0;
  let total = Infinity;
  let retrievedAt = "";
  const base = `${EDUCATION}?where=${encodeURIComponent(`code_commune="${codeInsee}"`)}&limit=100`;
  while (offset < total && offset < 1000) {
    const r = await http.json<{ total_count?: number; results?: Record<string, unknown>[] }>(`${base}&offset=${offset}`);
    retrievedAt = r.retrievedAt;
    total = r.data?.total_count ?? 0;
    const res = r.data?.results ?? [];
    for (const s of res) {
      const etat = str(pick(s, "etat"));
      if (etat && !/ouvert/i.test(etat)) continue;
      schools.push({
        id: str(pick(s, "identifiant_de_l_etablissement")),
        nom: str(pick(s, "nom_etablissement")),
        type: str(pick(s, "type_etablissement")),
        statut: str(pick(s, "statut_public_prive")),
        eleves: num(pick(s, "nombre_d_eleves")),
        priorite: str(pick(s, "appartenance_education_prioritaire")),
        lon: num(pick(s, "longitude")),
        lat: num(pick(s, "latitude")),
      });
    }
    if (!res.length) break;
    offset += res.length;
  }
  return { url: base, retrievedAt, schools };
}

/* ======================================================= SNCF Open Data */

export const SNCF = "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets";

export interface Station {
  nom: string;
  uic: string;
  segment: string;
  frequentation: { year: string; voyageurs: number }[];
  lon: number | null;
  lat: number | null;
}

/** Extrait les colonnes `total_voyageurs_AAAA` d'un enregistrement de fréquentation. */
export function parseFrequentation(rec: Record<string, unknown>) {
  const out: { year: string; voyageurs: number }[] = [];
  for (const [k, v] of Object.entries(rec)) {
    const m = k.match(/^total_voyageurs_(\d{4})$/);
    const n = num(v);
    if (m && n != null) out.push({ year: m[1], voyageurs: n });
  }
  return out.sort((a, b) => a.year.localeCompare(b.year));
}

export async function collectStations(http: TrackedHttp, codeInsee: string, codesPostaux: string[]) {
  const urls: string[] = [];
  const geoUrl = `${SNCF}/gares-de-voyageurs/records?where=${encodeURIComponent(`codeinsee="${codeInsee}"`)}&limit=50`;
  const g = await http.json<{ results?: Record<string, unknown>[] }>(geoUrl);
  urls.push(geoUrl);
  const stations: Station[] = (g.data?.results ?? []).map((s) => {
    const pos = pick(s, "position_geographique") as { lon?: number; lat?: number } | undefined;
    return {
      nom: str(pick(s, "nom", "libellecourt")),
      uic: str(pick(s, "codes_uic", "code_uic")),
      segment: str(pick(s, "segment_drg", "segmentation_drg")),
      frequentation: [],
      lon: pos?.lon ?? null,
      lat: pos?.lat ?? null,
    };
  });
  if (codesPostaux.length) {
    const where = `code_postal in (${codesPostaux.map((c) => `"${c}"`).join(",")})`;
    const fUrl = `${SNCF}/frequentation-gares/records?where=${encodeURIComponent(where)}&limit=50`;
    try {
      const f = await http.json<{ results?: Record<string, unknown>[] }>(fUrl);
      urls.push(fUrl);
      for (const rec of f.data?.results ?? []) {
        const uic = str(pick(rec, "code_uic_complet", "code_uic"));
        const nom = str(pick(rec, "nom_gare"));
        const freq = parseFrequentation(rec);
        const st = stations.find((s) => (uic && s.uic.includes(uic.slice(-6))) || s.nom.toLowerCase() === nom.toLowerCase());
        if (st) st.frequentation = freq;
        else stations.push({ nom, uic, segment: str(pick(rec, "segmentation_drg")), frequentation: freq, lon: null, lat: null });
      }
    } catch {
      http.partial = true;
      http.notes.push("Fréquentation des gares indisponible");
    }
  }
  return { urls, retrievedAt: g.retrievedAt, stations };
}

/* ============================================ Recherche d'entreprises */

export const ENTREPRISES = "https://recherche-entreprises.api.gouv.fr/search";

export const TRANCHES: Record<string, string> = {
  "00": "0 salarié",
  "01": "1 ou 2 salariés",
  "02": "3 à 5 salariés",
  "03": "6 à 9 salariés",
  "11": "10 à 19 salariés",
  "12": "20 à 49 salariés",
  "21": "50 à 99 salariés",
  "22": "100 à 199 salariés",
  "31": "200 à 249 salariés",
  "32": "250 à 499 salariés",
  "41": "500 à 999 salariés",
  "42": "1 000 à 1 999 salariés",
  "51": "2 000 à 4 999 salariés",
  "52": "5 000 à 9 999 salariés",
  "53": "10 000 salariés et plus",
};

export const SECTIONS_NAF: Record<string, string> = {
  A: "Agriculture, sylviculture et pêche",
  B: "Industries extractives",
  C: "Industrie manufacturière",
  D: "Énergie (électricité, gaz)",
  E: "Eau, assainissement, déchets",
  F: "Construction",
  G: "Commerce, réparation automobile",
  H: "Transports et entreposage",
  I: "Hébergement et restauration",
  J: "Information et communication",
  K: "Activités financières et d'assurance",
  L: "Activités immobilières",
  M: "Activités spécialisées, scientifiques et techniques",
  N: "Services administratifs et de soutien",
  O: "Administration publique",
  P: "Enseignement",
  Q: "Santé humaine et action sociale",
  R: "Arts, spectacles et activités récréatives",
  S: "Autres activités de services",
  T: "Activités des ménages employeurs",
  U: "Activités extra-territoriales",
};

export interface Employer {
  nom: string;
  siret: string;
  activite: string;
  section: string;
  tranche: string;
  trancheLabel: string;
  lon: number | null;
  lat: number | null;
}

interface EntrepriseResult {
  nom_complet?: string;
  section_activite_principale?: string;
  activite_principale?: string;
  matching_etablissements?: Record<string, unknown>[];
}

export async function collectEntreprises(http: TrackedHttp, codeInsee: string) {
  const urls: string[] = [];
  const opts = { minIntervalMs: 200 };
  // 1. Volume d'unités légales actives ayant un établissement dans la commune, par section NAF.
  const bySection: { section: string; label: string; count: number }[] = [];
  let retrievedAt = "";
  for (const s of Object.keys(SECTIONS_NAF)) {
    const u = `${ENTREPRISES}?code_commune=${codeInsee}&section_activite_principale=${s}&etat_administratif=A&per_page=1`;
    const r = await http.json<{ total_results?: number }>(u, opts);
    urls.push(u);
    retrievedAt = r.retrievedAt;
    const n = r.data?.total_results;
    if (typeof n === "number") bySection.push({ section: s, label: SECTIONS_NAF[s], count: n });
  }
  // 2. Établissements employeurs de 100 salariés et plus situés dans la commune.
  const employers: Employer[] = [];
  const big = ["22", "31", "32", "41", "42", "51", "52", "53"];
  for (let page = 1; page <= 4; page++) {
    const u = `${ENTREPRISES}?code_commune=${codeInsee}&tranche_effectif_salarie=${big.join(",")}&etat_administratif=A&per_page=25&page=${page}`;
    const r = await http.json<{ results?: EntrepriseResult[]; total_pages?: number }>(u, opts);
    urls.push(u);
    for (const e of r.data?.results ?? []) {
      for (const et of e.matching_etablissements ?? []) {
        const tranche = str(pick(et, "tranche_effectif_salarie"));
        if (str(pick(et, "commune")) && str(pick(et, "commune")) !== codeInsee) continue;
        if (!big.includes(tranche)) continue;
        if (str(pick(et, "etat_administratif")) === "F") continue;
        employers.push({
          nom: e.nom_complet ?? "",
          siret: str(pick(et, "siret")),
          activite: str(pick(et, "activite_principale")) || (e.activite_principale ?? ""),
          section: e.section_activite_principale ?? "",
          tranche,
          trancheLabel: TRANCHES[tranche] ?? tranche,
          lon: num(pick(et, "longitude")),
          lat: num(pick(et, "latitude")),
        });
      }
    }
    if (!r.data?.total_pages || page >= r.data.total_pages) break;
  }
  employers.sort((a, b) => b.tranche.localeCompare(a.tranche) || a.nom.localeCompare(b.nom));
  return { urls, retrievedAt, bySection, employers };
}
