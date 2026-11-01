export type RankingSet = Record<string, Record<string, number>>;
export const rankingKey = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
export function positions(entries: { id: string; count: number }[]) {
  const sorted = [...entries].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  let rank = 1;
  return Object.fromEntries(sorted.map((entry, index) => {
    if (index && entry.count !== sorted[index - 1].count) rank = index + 1;
    return [entry.id, rank];
  }));
}
export function rankingChanges(before: RankingSet, after: RankingSet) {
  return Object.fromEntries(Object.entries(after).map(([key, ranks]) => [key,
    Object.fromEntries(Object.entries(ranks).map(([id, rank]) => [id, before[key]?.[id] === undefined ? null : before[key][id] - rank]))
  ]));
}
type Item = { id: string; kind: string; status: string; genres?: string[]; episodeProgress?: { watched: number } };
type Company = { id: number; count: number };
type Data = { minutes: number; bySeries: { id: string; minutes: number }[]; preferences: {
  actors: { id: string; kind: string; count: number }[];
  characters: { itemId: string; name: string; count: number }[];
  productionCompanies: Company[]; seriesProductionCompanies: Company[];
  watchedMovieCompanies: Company[]; watchedSeriesCompanies: Company[];
  feelingSources: { itemId: string; kind: string; feeling: string; count: number }[];
} };
export function snapshot(data: Data, items: Item[]): RankingSet {
  const result: RankingSet = {};
  const put = (key: string, entries: { id: string; count: number }[]) => { result[key] = positions(entries); };
  const combined = new Map<string, number>();
  for (const actor of data.preferences.actors) combined.set(actor.id, (combined.get(actor.id) || 0) + actor.count);
  put('general:actors', [...combined].map(([id, count]) => ({ id, count })));
  for (const kind of ['movie', 'series', 'game']) {
    put(kind + ':actors', data.preferences.actors.filter(actor => actor.kind === kind));
    put(kind + ':characters', data.preferences.characters.filter(entry => items.some(item => item.id === entry.itemId && item.kind === kind)).map(entry => ({ id: entry.itemId + ':' + entry.name, count: entry.count })));
    for (const mode of ['added', 'watched']) {
      const counts = new Map<string, number>();
      for (const item of items.filter(item => item.kind === kind && (mode === 'added' || item.status === 'completed' || (kind === 'series' && (item.episodeProgress?.watched || 0) > 0)))) {
        for (const genre of new Set((item.genres || []).filter(name => name.trim()).map(rankingKey))) counts.set(genre, (counts.get(genre) || 0) + 1);
      }
      put(kind + ':' + mode + 'Genres', [...counts].map(([id, count]) => ({ id, count })));
    }
  }
  for (const [key, companies] of Object.entries({ 'movie:companies-added': data.preferences.productionCompanies, 'movie:companies-watched': data.preferences.watchedMovieCompanies, 'series:companies-added': data.preferences.seriesProductionCompanies, 'series:companies-watched': data.preferences.watchedSeriesCompanies })) put(key, companies.map(company => ({ id: String(company.id), count: company.count })));
  put('series:time', data.bySeries.map(series => ({ id: series.id, count: series.minutes })));
  const sources = data.preferences.feelingSources.filter(source => source.kind === 'series');
  const maximum = new Map<string, number>();
  sources.forEach(source => maximum.set(source.itemId, Math.max(maximum.get(source.itemId) || 0, source.count)));
  const dominant = sources.filter(source => source.count === maximum.get(source.itemId));
  const totals = new Map<string, number>();
  for (const source of dominant) totals.set(source.feeling, (totals.get(source.feeling) || 0) + source.count);
  put('series:feelings', [...totals].map(([id, count]) => ({ id, count })));
  for (const feeling of totals.keys()) put('series:feeling:' + feeling, dominant.filter(source => source.feeling === feeling).map(source => ({ id: source.itemId, count: source.count })));
  return result;
}
