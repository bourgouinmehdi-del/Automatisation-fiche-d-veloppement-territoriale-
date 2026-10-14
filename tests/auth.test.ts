import { afterEach, describe, expect, it } from "vitest";
import { authEnabled, checkCredentials, hashPassword, readSession, signSession } from "@/lib/auth";

describe("connexion", () => {
  afterEach(() => {
    delete process.env.AUTH_USERS;
    delete process.env.AUTH_SECRET;
  });
  it("reste ouverte sans comptes déclarés", () => {
    expect(authEnabled()).toBe(false);
  });
  it("vérifie les mots de passe en clair et chiffrés", () => {
    process.env.AUTH_USERS = `marie:secret-de-test;Paul:${hashPassword("un-autre-secret")}`;
    expect(checkCredentials("MARIE", "secret-de-test")).toBe("marie");
    expect(checkCredentials("marie", "faux")).toBeNull();
    expect(checkCredentials("paul", "un-autre-secret")).toBe("paul");
    expect(checkCredentials("inconnu", "x")).toBeNull();
  });
  it("signe la session et refuse un cookie modifié ou un compte retiré", () => {
    process.env.AUTH_USERS = "marie:secret-de-test";
    process.env.AUTH_SECRET = "cle";
    const { token } = signSession("marie");
    expect(readSession(token)).toBe("marie");
    expect(readSession(token.slice(0, -2) + "xx")).toBeNull();
    process.env.AUTH_SECRET = "autre-cle";
    expect(readSession(token)).toBeNull();
    process.env.AUTH_SECRET = "cle";
    process.env.AUTH_USERS = "paul:x";
    expect(readSession(token)).toBeNull();
  });
});
