/**
 * Petit carillon (deux notes, moins d'une seconde) joué quand une fiche est prête :
 * la génération est longue, on peut faire autre chose en attendant.
 * Web Audio, sans fichier son ; silencieux si le navigateur bloque le son.
 */
export function playChime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [
      [880, 0],
      [1318.5, 0.16],
    ].forEach(([f, t]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.25, now + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.55);
      o.connect(g).connect(ctx.destination);
      o.start(now + t);
      o.stop(now + t + 0.6);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch {
    /* son indisponible */
  }
}
