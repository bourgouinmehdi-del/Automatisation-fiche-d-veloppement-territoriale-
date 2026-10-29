/** Chiffres clés groupés : « socio » puis « militant » sur des lignes distinctes, le reste ensemble. */
export function glanceRows<T extends { tone?: string }>(items: T[]): T[][] {
  const fam = (i: T) => (i.tone === "socio" || i.tone === "militant" ? i.tone : "autre");
  const rows: T[][] = [];
  for (const i of items) {
    const last = rows[rows.length - 1];
    if (last && fam(last[0]) === fam(i)) last.push(i);
    else rows.push([i]);
  }
  return rows;
}
