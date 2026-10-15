import { NextResponse } from "next/server";
import { communeFromReferentiel } from "@/lib/collectors/admin";
import { listReports, startJob } from "@/lib/report/store";
import { config } from "@/lib/config";
import type { ReportQuery, Scope } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ reports: await listReports() });
}

/** Lance une génération (ou une régénération) et renvoie l'identifiant du rapport. */
export async function POST(req: Request) {
  if (config.serverless)
    return NextResponse.json(
      {
        error:
          "La génération d'une fiche n'est pas possible sur Vercel : elle dure plusieurs minutes, télécharge des fichiers nationaux volumineux et doit conserver un cache, ce que les fonctions serverless ne permettent pas. Utilisez l'application en local (npm run dev) ou un hébergement de type serveur (voir README, section Déploiement).",
      },
      { status: 501 },
    );
  const body = (await req.json().catch(() => ({}))) as Partial<ReportQuery>;
  const code = String(body.codeInsee ?? "").toUpperCase();
  if (!communeFromReferentiel(code)) return NextResponse.json({ error: "Code INSEE inconnu" }, { status: 400 });
  const scopes: Scope[] = ["commune", "epci", "circonscription", "departement", "custom"];
  const scope = scopes.includes(body.scope as Scope) ? (body.scope as Scope) : "commune";
  const custom = Array.isArray(body.customCommunes) ? body.customCommunes.map(String).filter((c) => communeFromReferentiel(c.toUpperCase())).slice(0, 40) : undefined;
  const circo = Number(body.circo);
  if (scope === "circonscription" && !(Number.isInteger(circo) && circo >= 1 && circo <= 40)) return NextResponse.json({ error: "Numéro de circonscription manquant" }, { status: 400 });
  const id = startJob({ codeInsee: code, codePostal: body.codePostal, scope, customCommunes: scope === "custom" ? custom : undefined, circo: scope === "circonscription" ? circo : undefined });
  return NextResponse.json({ id });
}
