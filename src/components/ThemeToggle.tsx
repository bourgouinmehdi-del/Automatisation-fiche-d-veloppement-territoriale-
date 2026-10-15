"use client";

import { useEffect, useState } from "react";

/**
 * Bascule clair / sombre. Sans choix enregistré, le thème suit le réglage du
 * système ; le choix est mémorisé dans le navigateur (localStorage).
 */
export default function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setDark(t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);
  if (dark == null) return <span className="theme-toggle invisible" aria-hidden="true">☾</span>;
  const toggle = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* navigation privée : choix non mémorisé */
    }
    setDark(!dark);
  };
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label={dark ? "Passer en mode clair" : "Passer en mode sombre"} title={dark ? "Mode clair" : "Mode sombre"}>
      {dark ? "☀" : "☾"}
    </button>
  );
}
