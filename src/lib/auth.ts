import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Accès réservé aux membres du pôle : identifiant et mot de passe.
 *
 * Les comptes sont déclarés dans la variable d'environnement AUTH_USERS,
 * séparés par des points-virgules : « login:motdepasse » ou, mieux, avec un
 * mot de passe chiffré produit par `npm run mot-de-passe` :
 * « login:scrypt:<sel>:<empreinte> ». Sans AUTH_USERS, l'application reste
 * ouverte (usage local).
 *
 * La session est un cookie signé (HMAC-SHA256) avec AUTH_SECRET ; à défaut,
 * la clé est dérivée de AUTH_USERS (changer les comptes déconnecte tout le monde).
 */

export const SESSION_COOKIE = "fiches_session";
const SESSION_DAYS = 30;

interface User {
  login: string;
  check: (password: string) => boolean;
}

const eq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 32).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function users(): User[] {
  const raw = process.env.AUTH_USERS ?? "";
  return raw
    .split(/[;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(":");
      const login = entry.slice(0, i).trim().toLowerCase();
      const secret = entry.slice(i + 1);
      if (secret.startsWith("scrypt:")) {
        const [, salt, hash] = secret.split(":");
        return { login, check: (p: string) => eq(scryptSync(p, salt, 32), Buffer.from(hash, "base64url")) };
      }
      return { login, check: (p: string) => eq(Buffer.from(p), Buffer.from(secret)) };
    })
    .filter((u) => u.login);
}

export const authEnabled = () => users().length > 0;

const key = () => process.env.AUTH_SECRET || createHash("sha256").update(`fiches:${process.env.AUTH_USERS ?? ""}`).digest("hex");

export function checkCredentials(login: string, password: string): string | null {
  const l = login.trim().toLowerCase();
  const u = users().find((x) => x.login === l);
  // Calcul effectué même pour un identifiant inconnu (temps de réponse identique).
  const ok = u ? u.check(password) : (scryptSync(password, "x", 32), false);
  return ok ? u!.login : null;
}

export function signSession(login: string): { token: string; maxAge: number } {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = Buffer.from(JSON.stringify({ l: login, e: exp })).toString("base64url");
  const sig = createHmac("sha256", key()).update(payload).digest("base64url");
  return { token: `${payload}.${sig}`, maxAge: SESSION_DAYS * 86400 };
}

/** Identifiant de la session si le cookie est valide, non expiré et le compte toujours déclaré. */
export function readSession(token: string | undefined | null): string | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", key()).update(payload).digest();
  if (!eq(Buffer.from(sig, "base64url"), expected)) return null;
  try {
    const { l, e } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { l: string; e: number };
    if (!l || e < Date.now() / 1000) return null;
    return users().some((u) => u.login === l) ? l : null;
  } catch {
    return null;
  }
}

/* Limite des tentatives de connexion : 10 par quart d'heure et par adresse. */
const attempts = new Map<string, { n: number; since: number }>();
export function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.since > 15 * 60_000) {
    attempts.set(ip, { n: 1, since: now });
    return false;
  }
  a.n++;
  return a.n > 10;
}
export const resetAttempts = (ip: string) => attempts.delete(ip);
