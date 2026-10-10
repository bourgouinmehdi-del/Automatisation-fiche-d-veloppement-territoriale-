import { SOURCES } from "@/lib/collectors/catalog";

export default function Methodologie() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-sm leading-relaxed">
      <h1 className="mb-4 text-2xl font-bold text-[var(--accent-strong)]">Méthodologie et sources</h1>
      <h2 className="mb-2 mt-6 text-lg font-semibold">Principes</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>Toutes les valeurs proviennent de sources publiques identifiées ; chaque indicateur conserve sa source, son URL, sa date de récupération, son millésime, son échelle, son unité, sa méthode et ses limites.</li>
        <li>Les calculs (ratios, évolutions, écarts, valeurs atypiques) sont réalisés par du code déterministe et testé. Aucune valeur n&apos;est estimée ni imputée : une donnée absente est affichée « n.d. » et listée parmi les données manquantes.</li>
        <li>Écart significatif à une référence : au moins 2 points et 10 % en relatif pour un taux ; 10 % en relatif pour les autres grandeurs.</li>
        <li>Valeur atypique : score z robuste (médiane et écart absolu médian) d&apos;au moins 2 parmi des communes comparables (même région, population à ±30 %, densité comprise entre la moitié et le double).</li>
        <li>Les énoncés sont typés : constat, atout, point de vigilance, hypothèse (à vérifier), piste d&apos;action, élément à vérifier.</li>
        <li>La rédaction repose sur des gabarits ; un modèle de langage peut, en option, reformuler les paragraphes, sous contrôle automatique interdisant tout ajout de chiffre.</li>
        <li>Le chapitre électoral est strictement descriptif et agrégé ; aucune inférence individuelle ni aucun ciblage n&apos;est produit.</li>
      </ul>
      <h2 className="mb-2 mt-6 text-lg font-semibold">Sources</h2>
      <ul className="space-y-3">
        {Object.values(SOURCES).map((s) => (
          <li key={s.id} className="card p-3">
            <strong>{s.name}</strong> — {s.producer}
            <div className="text-[var(--ink-2)]">
              {s.access} Licence : {s.license}.
            </div>
            <div className="text-[var(--muted)]">Limites : {s.limits}</div>
            {s.homepage && (
              <a href={s.homepage} target="_blank" rel="noreferrer" className="break-all text-xs">
                {s.homepage}
              </a>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
