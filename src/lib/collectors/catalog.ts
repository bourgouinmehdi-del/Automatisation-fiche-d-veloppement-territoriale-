/**
 * Catalogue des sources de données. Ce fichier est la référence documentaire
 * (licence, modalités d'accès, limites) reprise dans la bibliographie des rapports
 * et dans SOURCES.md.
 */
export interface SourceInfo {
  id: string;
  name: string;
  producer: string;
  homepage: string;
  license: string;
  access: string;
  limits: string;
}

export const SOURCES: Record<string, SourceInfo> = {
  cog: {
    id: "cog",
    name: "Découpage administratif (COG 2026) et populations légales",
    producer: "INSEE / DGCL, paquet @etalab/decoupage-administratif v6.0.0",
    homepage: "https://github.com/etalab/decoupage-administratif",
    license: "Licence Ouverte 2.0 (données), MIT (code)",
    access: "Référentiel embarqué dans l'application (aucun appel réseau).",
    limits:
      "Population municipale des populations légales millésimées 2023 publiées par l'INSEE fin 2025 (en vigueur au 1er janvier 2026). Pas de géométries.",
  },
  geoapi: {
    id: "geoapi",
    name: "API Découpage administratif (geo.api.gouv.fr)",
    producer: "DINUM / Etalab, à partir de l'INSEE et de l'IGN (ADMIN EXPRESS)",
    homepage: "https://geo.api.gouv.fr/decoupage-administratif",
    license: "Licence Ouverte 2.0",
    access: "API REST publique sans clé.",
    limits: "Surfaces et contours issus d'ADMIN EXPRESS (généralisés). Population légale du dernier millésime publié.",
  },
  insee_melodi: {
    id: "insee_melodi",
    name: "INSEE — API Melodi (recensement, Filosofi, populations de référence)",
    producer: "INSEE",
    homepage: "https://portail-api.insee.fr/catalog/api/a890b735-159c-4c91-90b7-35159c7c9126",
    license: "Licence Ouverte 2.0",
    access: "API REST publique sans clé (limite indicative : 30 requêtes/minute).",
    limits:
      "Recensement : moyenne de 5 enquêtes annuelles (millésime N = enquêtes N-2 à N+2) ; comparaisons temporelles à faire à 5 ans d'écart. Filosofi : secret statistique pour les petites communes (valeurs non diffusées).",
  },
  dvf: {
    id: "dvf",
    name: "Demandes de valeurs foncières géolocalisées (DVF)",
    producer: "DGFiP, géolocalisation Etalab",
    homepage: "https://files.data.gouv.fr/geo-dvf/latest/csv/",
    license: "Licence Ouverte 2.0",
    access: "Fichiers CSV par commune et par année.",
    limits:
      "Mutations à titre onéreux uniquement ; hors Alsace-Moselle et Mayotte ; prix au m² calculés sur les ventes d'un seul local d'habitation avec surface bâtie renseignée. Petits effectifs instables.",
  },
  osm: {
    id: "osm",
    name: "OpenStreetMap (API Overpass)",
    producer: "Contributeurs OpenStreetMap",
    homepage: "https://www.openstreetmap.org/copyright",
    license: "ODbL 1.0",
    access: "API Overpass publique (usage raisonnable, quotas par IP).",
    limits:
      "Couverture variable selon les contributeurs : une absence d'objet ne prouve pas une absence d'équipement.",
  },
  georisques: {
    id: "georisques",
    name: "Géorisques — base GASPAR (risques, arrêtés CatNat)",
    producer: "Ministère de la Transition écologique / BRGM",
    homepage: "https://www.georisques.gouv.fr/doc-api",
    license: "Licence Ouverte 2.0",
    access: "API REST publique sans clé.",
    limits: "Inventaire réglementaire des risques connus ; ne remplace pas un diagnostic local.",
  },
  education: {
    id: "education",
    name: "Annuaire de l'éducation",
    producer: "Ministère de l'Éducation nationale",
    homepage: "https://data.education.gouv.fr/explore/dataset/fr-en-annuaire-education/",
    license: "Licence Ouverte 2.0",
    access: "API Opendatasoft (Explore v2.1) sans clé.",
    limits: "Établissements ouverts ; effectifs non systématiquement renseignés.",
  },
  sncf: {
    id: "sncf",
    name: "SNCF Open Data — fréquentation des gares",
    producer: "SNCF Gares & Connexions",
    homepage: "https://ressources.data.sncf.com/explore/dataset/frequentation-gares/",
    license: "ODbL 1.0",
    access: "API Opendatasoft (Explore v2.1) sans clé.",
    limits: "Voyageurs annuels estimés (montants et descendants) ; dernière année publiée.",
  },
  entreprises: {
    id: "entreprises",
    name: "API Recherche d'entreprises (base SIRENE)",
    producer: "DINUM, à partir de la base SIRENE de l'INSEE",
    homepage: "https://recherche-entreprises.api.gouv.fr/docs/",
    license: "Licence Ouverte 2.0",
    access: "API REST publique sans clé (7 requêtes/seconde).",
    limits:
      "Tranches d'effectifs déclaratives et parfois anciennes ; l'effectif peut concerner l'unité légale et non l'établissement local.",
  },
  elections: {
    id: "elections",
    name: "Résultats électoraux officiels",
    producer: "Ministère de l'Intérieur (data.gouv.fr)",
    homepage: "https://www.data.gouv.fr/fr/pages/donnees-des-elections/",
    license: "Licence Ouverte 2.0",
    access: "Fichiers CSV interrogés via l'API tabulaire de data.gouv.fr.",
    limits:
      "Résultats agrégés par commune et par bureau de vote ; le découpage des bureaux peut changer d'un scrutin à l'autre ; aucune inférence sur les comportements individuels.",
  },
  bureaux_geo: {
    id: "bureaux_geo",
    name: "Géographie des bureaux de vote",
    producer: "INSEE — Répertoire électoral unique (adresses des électeurs) / Etalab ; ou fichier fourni",
    homepage: "https://www.data.gouv.fr/fr/datasets/bureaux-de-vote-et-adresses-de-leurs-electeurs/",
    license: "Licence Ouverte 2.0",
    access: "API tabulaire de data.gouv.fr ; ou GeoJSON déposé dans data/interne/.",
    limits: "Enveloppes calculées à partir des adresses : contours approximatifs, pouvant se chevaucher. Découpage susceptible d'avoir changé depuis le scrutin.",
  },
  interne: {
    id: "interne",
    name: "Données militantes internes",
    producer: "Fichiers fournis par l'utilisateur (data/interne/)",
    homepage: "",
    license: "Usage interne",
    access: "Fichiers CSV locaux, non versionnés.",
    limits: "Données non publiques, non vérifiées par l'application ; agrégats par commune uniquement.",
  },
  osm_tiles: {
    id: "osm_tiles",
    name: "Fond de carte OpenStreetMap",
    producer: "Contributeurs OpenStreetMap",
    homepage: "https://www.openstreetmap.org/copyright",
    license: "ODbL 1.0 / CC BY-SA",
    access: "Tuiles raster (affichage interactif uniquement).",
    limits: "Fond de carte illustratif.",
  },
  svgmaps: {
    id: "svgmaps",
    name: "Carte SVG des départements français (@svg-maps/france.departments)",
    producer: "VictorCazanave / svg-maps",
    homepage: "https://github.com/VictorCazanave/svg-maps",
    license: "CC BY 4.0",
    access: "Fond embarqué.",
    limits: "Contours simplifiés, usage de localisation uniquement.",
  },
  calcul: {
    id: "calcul",
    name: "Calcul de l'application",
    producer: "Moteur d'analyse déterministe (src/lib/analysis)",
    homepage: "",
    license: "—",
    access: "—",
    limits: "Valeurs dérivées des sources citées dans la méthode.",
  },
};
