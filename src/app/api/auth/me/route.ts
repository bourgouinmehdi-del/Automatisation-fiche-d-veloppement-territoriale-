import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authEnabled, readSession, roleOf, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Compte connecté et rôle (l'interface masque les actions non permises). */
export async function GET() {
  const user = authEnabled() ? readSession((await cookies()).get(SESSION_COOKIE)?.value) : null;
  return NextResponse.json({ user, role: roleOf(user), auth: authEnabled() });
}
