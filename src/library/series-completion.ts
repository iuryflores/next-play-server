export type SeriesLifecycle = { seriesStatus?: 'ended' | 'canceled' | 'returning' | 'unknown'; episodeCount?: number };

export function finishedSeries(lifecycle: SeriesLifecycle | undefined, seasons: { loaded?: boolean; episodes?: { number: number; airDate?: string }[]; number: number }[], watched: Set<string>, today: string) {
  // 100% dos episódios locais não prova que a série acabou: exige encerramento e catálogo completo.
  if (!lifecycle || !['ended', 'canceled'].includes(lifecycle.seriesStatus || '') || !lifecycle.episodeCount) return false;
  const regular = seasons.filter(season => season.number > 0);
  if (!regular.length || regular.some(season => !season.loaded)) return false;
  const episodes = regular.flatMap(season => (season.episodes || []).map(episode => ({ ...episode, season: season.number })));
  return episodes.length === lifecycle.episodeCount && episodes.every(episode => (!episode.airDate || episode.airDate <= today) && watched.has(`${episode.season}:${episode.number}`));
}
