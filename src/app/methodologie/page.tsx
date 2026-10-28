import { SOURCES } from "@/lib/collectors/catalog";

export default function Methodologie() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-sm leading-relaxed">
      <h1 className="mb-4 text-2xl font-bold text-[var(--accent-strong)]">Méthodologie et sources</h1>
      <h2 className="mb-2 mt-6 text-lg font-semibold">Principes</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>Tous les chiffres viennent de sources publiques (INSEE, ministère de l&apos;Intérieur, SNCF…) ou des données internes du mouvement. Pour chacun, la fiche garde la source, la date de téléchargement et l&apos;année des données : on peut toujours vérifier d&apos;où il vient (numéros entre crochets, bibliographie en fin de fiche).</li>
        <li>Les calculs (taux, évolutions, comparaisons) sont faits par le programme, toujours de la même façon. Rien n&apos;est inventé ni estimé à la main : une donnée absente est notée « n.d. » et signalée.</li>
        <li>Une commune n&apos;est dite « au-dessus » ou « en dessous » d&apos;une autre que si l&apos;écart est net : au moins 2 points et 10 % pour un taux, 10 % pour les autres chiffres.</li>
        <li>Les textes de la fiche sont écrits à partir de phrases types, remplies avec les chiffres calculés. Une intelligence artificielle peut, si on l&apos;active, reformuler ces phrases pour les rendre plus fluides ; un contrôle automatique vérifie alors qu&apos;elle n&apos;a ajouté ni modifié aucun chiffre.</li>
        <li>Les résultats électoraux sont utilisés à l&apos;échelle de la commune et du bureau de vote (résultats officiels) ; aucune donnée sur une personne n&apos;est utilisée. Les bureaux prioritaires sont ceux où l&apos;on vote déjà le plus pour la France insoumise et où le plus d&apos;inscrits ne votent pas.</li>
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
