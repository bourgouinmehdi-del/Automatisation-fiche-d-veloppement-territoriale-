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
import { ciblageAcces, type AccesTarget } from "./acces";
import { plmInfo } from "../collectors/plm";
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
  // Ciblage : temps de trajet depuis les villes militantes proches (calculé une fois les territoires choisis).
  const chosen = (lfi as { chosen?: AccesTarget[] }).chosen;
  if (territorial(query.scope) && chosen?.length && lfi.section) {
    emit({ step: "acces", label: "Temps de trajet depuis les villes militantes", done: total - 2, total, status: "running" });
    const acc = await ciblageAcces(c, chosen).catch(() => null);
    if (acc) {
      lfi.tables.push(...acc.tables);
      lfi.maps.push(...acc.maps);
      const i = lfi.section.blocks.findIndex((b) => b.type === "heading" && /^Classement/.test(b.text));
      lfi.section.blocks.splice(i < 0 ? lfi.section.blocks.length : i, 0, ...acc.blocks);
    }
  }
  // Fiche commune : temps de trajet depuis les villes militantes proches (après « Accès »).
  if (!territorial(query.scope) && lfi.section) {
    const plm = plmInfo(c.commune.code);
    const acc = await ciblageAcces(c, [{ nom: c.commune.nom, codes: [plm?.parent ?? c.commune.code], color: "#f3b51b" }], { fiche: true }).catch(() => null);
    if (acc) {
      lfi.tables.push(...acc.tables);
      lfi.maps.push(...acc.maps);
      const bl = lfi.section.blocks;
      // « Accès » : les villes déjà dans le tableau des villes militantes n'y sont pas répétées (un seul temps par ville).
      const villes = new Set((acc.tables[0]?.rows ?? []).map((r) => String(r.ville ?? "")));
      const iAcc0 = bl.findIndex((b) => b.type === "paragraph" && /^\*\*Accès\*\*/.test(b.text));
      if (iAcc0 >= 0) {
        const b = bl[iAcc0] as { text: string };
        const m = b.text.match(/^(\*\*Accès\*\* : )(.*?)( \((?:temps|distances)[^)]*\))?\.$/);
        if (m) {
          const parts = m[2].split(" ; ").filter((x) => ![...villes].some((v) => v && x.startsWith(`${v} à `)));
          if (parts.length) b.text = `${m[1]}${parts.join(" ; ")}${parts.some((x) => /min|h \d/.test(x)) ? (m[3] ?? "") : ""}.`;
          else bl.splice(iAcc0, 1);
        }
      }
      // Ordre : accès, liste aux municipales, puis les villes militantes (carte et tableau).
      const iMun = bl.findIndex((b) => b.type === "paragraph" && /^\*\*Municipales 2026\*\*/.test(b.text));
      const iAcc = bl.findIndex((b) => b.type === "paragraph" && /^\*\*Accès\*\*/.test(b.text));
      const iOp = bl.findIndex((b) => b.type === "heading" && b.text === "Opérationnel");
      const at = iMun >= 0 ? iMun + 1 : iAcc >= 0 ? iAcc + 1 : iOp >= 0 ? iOp + 1 : bl.length;
      bl.splice(at, 0, ...acc.blocks);
    }
  }
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
