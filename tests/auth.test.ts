import { afterEach, describe, expect, it } from "vitest";
import { authEnabled, can, checkCredentials, hashPassword, readSession, requiredRole, roleOf, signSession } from "@/lib/auth";

describe("connexion", () => {
  afterEach(() => {
    delete process.env.AUTH_USERS;
    delete process.env.AUTH_SECRET;
    delete process.env.AUTH_ROLES;
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
  it("rôles : admin, éditeur, lecteur", () => {
    // Sans authentification : tout est permis.
    expect(roleOf(null)).toBe("admin");
    process.env.AUTH_USERS = "marie:a;paul:b;lea:c";
    // Aucun admin déclaré : tous admin (pas d'accès perdu à la mise à jour).
    expect(roleOf("paul")).toBe("admin");
    process.env.AUTH_ROLES = "Marie:admin; lea:lecteur";
    expect(roleOf("marie")).toBe("admin");
    expect(roleOf("paul")).toBe("editeur");
    expect(roleOf("lea")).toBe("lecteur");
    expect(requiredRole("POST", "/api/interne")).toBe("admin");
    expect(requiredRole("GET", "/api/interne")).toBeNull();
    expect(requiredRole("DELETE", "/api/interne/emploi")).toBe("admin");
    expect(requiredRole("GET", "/donnees-internes")).toBe("admin");
    expect(requiredRole("POST", "/api/reports")).toBe("editeur");
    expect(requiredRole("PUT", "/api/reports/x/notes")).toBe("editeur");
    expect(requiredRole("GET", "/api/reports/x/export/pdf")).toBeNull();
    expect(can("paul", "admin")).toBe(false);
    expect(can("paul", "editeur")).toBe(true);
    expect(can("lea", "editeur")).toBe(false);
    expect(can("marie", "admin")).toBe(true);
  });
});
