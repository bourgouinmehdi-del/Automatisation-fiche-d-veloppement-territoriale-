import { NextResponse } from "next/server";
import { communeFromReferentiel, departementGeo } from "@/lib/collectors/admin";
import { circoCommunes, circoLabel, collectCirconscriptions } from "@/lib/collectors/carto";
import { TrackedHttp } from "@/lib/collectors/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Circonscriptions législatives couvrant une commune (avec la part de sa
 * surface dans chacune) : choix de la circonscription sur la page d'accueil.
 * La première demande pour un département télécharge les contours (mis en cache).
 */
export async function GET(req: Request) {
  const code = (new URL(req.url).searchParams.get("commune") ?? "").toUpperCase();
  const com = communeFromReferentiel(code);
  if (!com) return NextResponse.json({ error: "Code INSEE inconnu" }, { status: 400 });
  const dep = com.departement;
  try {
    const http = new TrackedHttp();
    const [geo, cir] = await Promise.all([departementGeo(http, dep.code), collectCirconscriptions(http, dep.code)]);
    const feat = geo.fc?.features.find((f) => (f.properties as { code?: string })?.code === code);
    const circos = cir.circos
      .map((c) => ({ num: c.num, label: circoLabel(c.num, dep.nom), share: feat ? (circoCommunes([feat], c).get(code) ?? 0) : 0 }))
      .filter((c) => c.share > 0)
      .sort((a, b) => b.share - a.share);
    return NextResponse.json({ departement: dep.nom, circos, total: cir.circos.length });
  } catch (e) {
    return NextResponse.json({ error: `Circonscriptions indisponibles : ${e instanceof Error ? e.message : e}` }, { status: 502 });
  }
}
