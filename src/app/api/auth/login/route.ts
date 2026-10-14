import { NextResponse } from "next/server";
import { checkCredentials, resetAttempts, SESSION_COOKIE, signSession, tooManyAttempts } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  if (tooManyAttempts(ip)) return NextResponse.json({ error: "Trop de tentatives : réessayez dans un quart d'heure." }, { status: 429 });
  const body = (await req.json().catch(() => null)) as { login?: unknown; password?: unknown } | null;
  const login = typeof body?.login === "string" ? body.login : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const user = login && password ? checkCredentials(login, password) : null;
  if (!user) return NextResponse.json({ error: "Identifiant ou mot de passe incorrect." }, { status: 401 });
  resetAttempts(ip);
  const { token, maxAge } = signSession(user);
  const res = NextResponse.json({ ok: true, login: user });
  const secure = (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";
  res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge });
  return res;
}
