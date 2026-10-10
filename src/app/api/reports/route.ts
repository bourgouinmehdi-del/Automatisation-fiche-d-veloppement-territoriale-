import { NextResponse } from "next/server";
import { communeFromReferentiel } from "@/lib/collectors/admin";
import { listReports, startJob } from "@/lib/report/store";
import type { ReportQuery, Scope } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ reports: await listReports() });
}

/** Lance une génération (ou une régénération) et renvoie l'identifiant du rapport. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<ReportQuery>;
  const code = String(body.codeInsee ?? "").toUpperCase();
  if (!communeFromReferentiel(code)) return NextResponse.json({ error: "Code INSEE inconnu" }, { status: 400 });
  const scopes: Scope[] = ["commune", "epci", "departement", "custom"];
  const scope = scopes.includes(body.scope as Scope) ? (body.scope as Scope) : "commune";
  const custom = Array.isArray(body.customCommunes) ? body.customCommunes.map(String).filter((c) => communeFromReferentiel(c.toUpperCase())).slice(0, 40) : undefined;
  const id = startJob({ codeInsee: code, codePostal: body.codePostal, scope, customCommunes: scope === "custom" ? custom : undefined });
  return NextResponse.json({ id });
}
