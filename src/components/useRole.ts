"use client";

import { useEffect, useState } from "react";

export type Role = "admin" | "editeur" | "lecteur";
let cache: Promise<Role> | null = null;

/** Rôle du compte connecté ; « editeur » en attendant la réponse (les boutons restent visibles). */
export function useRole(): Role {
  const [role, setRole] = useState<Role>("editeur");
  useEffect(() => {
    cache ??= fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d: { role?: Role }) => d.role ?? "editeur")
      .catch(() => "editeur" as Role);
    cache.then(setRole);
  }, []);
  return role;
}
