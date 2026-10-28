"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { VoteMode } from "@/lib/types";

/**
 * Lecture du vote choisie sur la page (part des voix ou part des inscrits) : un clic sur le bouton
 * d'une carte ou d'un graphique change toutes les cartes et tous les graphiques de la fiche.
 */
const Ctx = createContext<{ mode: VoteMode; setMode: (m: VoteMode) => void } | null>(null);

export function VoteModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<VoteMode>("exp");
  return <Ctx.Provider value={{ mode, setMode }}>{children}</Ctx.Provider>;
}

/** Hors d'une fiche (comparaison, aperçu) : choix propre au composant. */
export function useVoteMode() {
  const shared = useContext(Ctx);
  const [mode, setMode] = useState<VoteMode>("exp");
  return shared ?? { mode, setMode };
}

export const isVoteMode = (id: string): id is VoteMode => id === "exp" || id === "ins";

/** Boutons « Part des voix / Part des inscrits ». */
export function VoteModeButtons({ modes }: { modes: { id: string; label: string }[] }) {
  const { mode, setMode } = useVoteMode();
  return (
    <span className="no-print flex gap-1" role="group" aria-label="Lecture du vote">
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          aria-pressed={m.id === mode}
          onClick={() => isVoteMode(m.id) && setMode(m.id)}
          className={`rounded-full border px-2.5 py-0.5 text-xs ${m.id === mode ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)] text-[var(--ink-2)]"}`}
        >
          {m.label}
        </button>
      ))}
    </span>
  );
}
