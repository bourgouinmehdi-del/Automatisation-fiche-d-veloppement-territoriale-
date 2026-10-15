import { Readable } from "node:stream";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authEnabled, can, readSession, SESSION_COOKIE } from "@/lib/auth";
import { importStmt, removeStmt, stmtSummary } from "@/lib/collectors/emploi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Route exclue du middleware (corps volumineux) : la session est vérifiée ici. */
async function denied(need: "admin" | null = "admin") {
  if (!authEnabled()) return null;
  const jar = await cookies();
  const user = readSession(jar.get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: "Connexion requise" }, { status: 401 });
  return !need || can(user, need) ? null : NextResponse.json({ error: "Réservé aux administrateurs" }, { status: 403 });
}

export async function GET() {
  return (await denied(null)) ?? NextResponse.json(await stmtSummary());
}

/**
 * Dépôt en flux d'un fichier de demandeurs d'emploi (communal ou national),
 * envoyé brut ou compressé (gzip, `?gzip=1`) : il n'est jamais chargé en entier
 * en mémoire.
 */
export async function POST(req: Request) {
  const d = await denied();
  if (d) return d;
  if (!req.body) return NextResponse.json({ error: "Fichier manquant" }, { status: 400 });
  const gzip = new URL(req.url).searchParams.get("gzip") === "1";
  try {
    const r = await importStmt(Readable.fromWeb(req.body as import("node:stream/web").ReadableStream), { gzip });
    const per = (m: string) => `${m.slice(4)}/${m.slice(0, 4)}`;
    return NextResponse.json({
      ok: true,
      info: r.kind === "national" ? `série nationale, ${per(r.first)} à ${per(r.last)}` : `${r.communes.toLocaleString("fr-FR")} communes, ${per(r.first)} à ${per(r.last)}`,
      summary: await stmtSummary(),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const d = await denied();
  if (d) return d;
  const kind = new URL(req.url).searchParams.get("kind");
  if (kind !== "communes" && kind !== "national") return NextResponse.json({ error: "Type inconnu" }, { status: 400 });
  await removeStmt(kind);
  return NextResponse.json({ ok: true, summary: await stmtSummary() });
}
