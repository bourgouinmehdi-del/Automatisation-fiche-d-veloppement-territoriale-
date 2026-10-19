import { criticalMessage } from "./warnings";
import crypto from "node:crypto";
import { computeFindings } from "../analysis/findings";
import { getProvider, safeRewrite } from "../llm/provider";
import { config } from "../config";
import type { GeoRef, ProgressEvent, Report, ReportQuery } from "../types";
import { assemble } from "./assemble";
import { collect, PROGRESS_TOTAL, territorial } from "./collect";
import { buildSections } from "./sections";
import { buildLfi } from "./lfi";
import { buildCiblage } from "./ciblage";
import { buildEmploi } from "./emploi";

/**
 * Chaîne complète de génération d'une fiche :
 * collecte → normalisation/assemblage → calculs et constats → rédaction → plan.
 */
export async function buildReport(
  query: ReportQuery,
  onProgress: (e: ProgressEvent) => void = () => {},
  id = reportId(query),
): Promise<Report> {
  const emit = (e: Omit<ProgressEvent, "at">) =>
    onProgress({ ...e, at: new Date().toISOString() });
  const c = await collect(query, emit);
  const total = PROGRESS_TOTAL;

  emit({
    step: "assemblage",
    label: "Normalisation des indicateurs, tableaux, graphiques et cartes",
    done: total - 3,
    total,
    status: "running",
  });
  const a = assemble(c);
  // Demandeurs d'emploi (fichiers France Travail déposés).
  const emp = buildEmploi(c);
  a.indicators.push(...emp.indicators);
  a.tables.push(...emp.tables);
  a.charts.push(...emp.charts);

  emit({
    step: "analyse",
    label: "Calcul des écarts, détection des valeurs atypiques et constats",
    done: total - 2,
    total,
    status: "running",
  });
  const focusGeo: GeoRef =
    c.focus.level === "commune"
      ? c.geos.commune
      : c.focus.level === "epci" && c.geos.epci
        ? c.geos.epci
        : c.geos.departement;
  const references = [
    c.geos.epci,
    c.geos.departement,
    c.geos.region,
    c.geos.france,
  ].filter((g): g is GeoRef => !!g && g.level !== focusGeo.level);
  const findings = computeFindings({
    focus: focusGeo,
    references,
    indicators: a.indicators,
    missing: a.missing,
    comparables: c.comparables.map((cp) => ({
      code: cp.code,
      values: Object.fromEntries(
        (cp.result?.indicators ?? []).map((i) => [i.id, i.value]),
      ),
    })),
    population: c.commune.population,
  });

  // Fiche d'action (approche LFI) pour une commune ; ciblage départemental pour un département.
  const lfi =
    territorial(query.scope)
      ? { ...buildCiblage(c), charts: [] }
      : buildLfi(c, a.indicators, { emploiText: emp.ficheText });
  a.indicators.push(...lfi.indicators);
  a.tables.push(...lfi.tables);
  a.charts.push(...lfi.charts);
  a.maps.push(...lfi.maps);
  findings.push(...lfi.findings, ...emp.findings);

  emit({
    step: "redaction",
    label: "Rédaction des commentaires",
    done: total - 1,
    total,
    status: "running",
  });
  const sections = [
    ...(lfi.section ? [lfi.section] : []),
    ...("extra" in lfi && lfi.extra ? lfi.extra : []),
    ...buildSections({
      c,
      indicators: a.indicators,
      tables: a.tables,
      charts: a.charts,
      maps: a.maps,
      findings,
    }),
  ];
  const provider = getProvider();
  for (const s of sections)
    for (const b of s.blocks)
      if (b.type === "paragraph")
        b.text = await safeRewrite(
          provider,
          b.text,
          `Partie ${s.letter} — ${s.title}, ${c.commune.nom}`,
        );

  const warnings = [...c.warnings];
  if (config.offline)
    warnings.push(
      "Mode hors ligne : seules les données en cache et les référentiels embarqués ont été utilisés.",
    );
  // Seuls les échecs qui privent la fiche de l'essentiel sont mis en avant (voir warnings.ts).
  const crit = criticalMessage(c.ctx.runs.filter((r) => r.status === "failed"));
  if (crit) warnings.push(crit);

  const now = new Date().toISOString();
  const report: Report = {
    id,
    version: 1,
    createdAt: now,
    updatedAt: now,
    query,
    commune: c.commune,
    focus: c.focus,
    perimeter: c.perimeter,
    references: [c.geos.commune, ...references],
    indicators: a.indicators,
    series: a.series,
    tables: a.tables,
    charts: a.charts,
    maps: a.maps,
    findings,
    sections,
    runs: c.ctx.runs,
    missing: a.missing,
    narrativeEngine: provider.name,
    warnings,
  };
  emit({
    step: "termine",
    label: "Fiche générée",
    done: total,
    total,
    status: "done",
  });
  return report;
}

export function reportId(q: ReportQuery) {
  const key = [q.codeInsee, q.scope, ...(q.scope === "circonscription" ? [`circo${q.circo}`] : []), ...(q.customCommunes ?? []).sort()].join(
    "|",
  );
  return `${q.codeInsee}-${q.scope}-${crypto.createHash("sha1").update(key).digest("hex").slice(0, 6)}`;
}
