export const brazilianAgeBands = [0, 6, 10, 12, 14, 16, 18] as const;
export type BrazilianAge = typeof brazilianAgeBands[number];

function ageFromLabel(value: unknown): BrazilianAge | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim().toUpperCase();
  if (label === 'L' || label === 'LIVRE') return 0;
  return brazilianAgeBands.find(age => age > 0 && String(age) === label);
}

export function brazilianAgeRating(rows: {
  iso_3166_1?: unknown;
  rating?: unknown;
  release_dates?: { certification?: unknown }[];
}[], kind: 'movie' | 'series'): BrazilianAge | null {
  const ages = rows.filter(row => row?.iso_3166_1 === 'BR').flatMap(row =>
    kind === 'movie'
      ? (Array.isArray(row.release_dates) ? row.release_dates.map(release => ageFromLabel(release?.certification)) : [])
      : [ageFromLabel(row.rating)],
  ).filter((age): age is BrazilianAge => age !== undefined);
  // Um filme pode ter classificações diferentes por edição ou lançamento. Usa a maior registrada.
  return ages.reduce<BrazilianAge | null>((highest, age) => highest === null || age > highest ? age : highest, null);
}
