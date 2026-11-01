import type { RankingSet } from './ranking-snapshot';
// Scores are represented by their competition rank. Lower values mean higher scores.
export function stablePositions(current: RankingSet, previous: RankingSet = {}): RankingSet {
  return Object.fromEntries(Object.entries(current).map(([key, ranks]) => [key,
    Object.fromEntries(Object.keys(ranks).sort((a, b) => ranks[a] - ranks[b] || (previous[key]?.[a] ?? Number.MAX_SAFE_INTEGER) - (previous[key]?.[b] ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b)).map((id, index) => [id, index + 1]))
  ]));
}
