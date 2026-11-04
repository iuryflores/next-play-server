export const xpRules = {
  movie: { label: 'Filmes assistidos', rate: 20 },
  rewatch: { label: 'Filmes revistos', rate: 20 },
  movieHour: { label: 'Horas assistidas em filmes', rate: 5 },
  episodeHour: { label: 'Horas assistidas em episódios', rate: 5 },
  episode: { label: 'Episódios assistidos', rate: 5 },
  book: { label: 'Livros concluídos', rate: 50 },
  game: { label: 'Jogos concluídos', rate: 50 },
  hour: { label: 'Horas jogadas', rate: 2 },
  review: { label: 'Avaliações', rate: 3 },
  achievement: { label: 'Conquistas desbloqueadas', rate: 25 },
} as const;
export type XpKind = keyof typeof xpRules;

export function levelFromXp(xp: number) {
  // Após n avanços: 100*n + 25*n*(n-1)/2 XP. A inversão evita laços por nível.
  const totalXp = Math.max(0, Math.floor(xp));
  const advances = Math.floor((Math.sqrt(49 + 4 * totalXp / 12.5) - 7) / 2);
  const floor = (n: number) => 100 * n + 25 * n * (n - 1) / 2;
  return { level: advances + 1, totalXp, currentXp: totalXp - floor(advances), requiredXp: 100 + advances * 25 };
}

export type XpItem = { _id: { toString(): string }; kind: string; status: string; title: string; catalogId?: string; catalogKey?: string; year?: string; stars?: number; feeling?: string; playtimeMinutes?: number; runtime?: number | null; rewatches?: { id: string; completedAt?: Date | string | null }[] };
export type XpEpisode = { itemId: { toString(): string }; season: number; episode: number; watchedAt?: Date; watchedDateUnknown?: boolean; runtime?: number | null; stars?: number; feeling?: string };
export type Candidate = { key: string; kind: XpKind; label: string; units: number };
export function xpCandidates(items: XpItem[], episodes: XpEpisode[], awards: { key: string; name: string }[]): Candidate[] {
  const result = new Map<string, Candidate>();
  const identity = (item: XpItem) => `${item.kind}:${item.catalogId || item.catalogKey || `${item.title.trim().toLowerCase()}:${item.year || ''}`}`;
  const add = (kind: XpKind, key: string, label: string, units = 1) => {
    if (units <= 0) return;
    const id = `${kind}:${key}`;
    if ((result.get(id)?.units || 0) < units) result.set(id, { key: id, kind, label, units });
  };
  const reviewed = (row: { stars?: number; feeling?: string }) => (row.stars || 0) > 0 || Boolean(row.feeling);
  const minutes = (runtime?: number | null) => typeof runtime === 'number' && Number.isFinite(runtime) && runtime > 0 ? runtime : 0;
  for (const item of items) {
    const key = identity(item);
    // Conta somente repetições encerradas; reenvios e linhas duplicadas usam o máximo por identidade da obra.
    const rewatches = item.kind === 'movie' ? new Set((item.rewatches || []).filter(row => row.id && row.completedAt && Number.isFinite(new Date(row.completedAt).getTime())).map(row => row.id)).size : 0;
    const completed = item.status === 'completed' || (item.kind === 'movie' && rewatches > 0);
    if (completed) {
      if (item.kind === 'movie' || item.kind === 'book' || item.kind === 'game') add(item.kind, key, item.title);
      if (reviewed(item)) add('review', key, item.title);
    }
    if (item.kind === 'movie') {
      add('rewatch', key, item.title, rewatches);
      // Frações se somam entre visualizações do mesmo filme. Sem duração conhecida, não inventa tempo.
      add('movieHour', key, item.title, Math.floor(minutes(item.runtime) * (Number(completed) + rewatches) / 60));
    }
    // Limite vitalício por jogo, sem exigir datas que o histórico antigo não possui.
    if (item.kind === 'game') add('hour', key, item.title, Math.min(100, Math.floor(Math.max(0, item.playtimeMinutes || 0) / 60)));
  }
  const series = new Map(items.filter(item => item.kind === 'series').map(item => [item._id.toString(), item]));
  const episodeMinutes = new Map<string, { series: string; label: string; minutes: number }>();
  for (const row of episodes) {
    const item = series.get(row.itemId.toString());
    if (!item || (!row.watchedAt && !row.watchedDateUnknown) || row.season <= 0 || row.episode <= 0) continue;
    const key = `${identity(item)}:${row.season}:${row.episode}`;
    const label = `${item.title} — T${row.season} E${row.episode}`;
    add('episode', key, label);
    // O episódio distinto contribui uma vez, mesmo com registros duplicados ou múltiplos exemplares da série.
    if ((episodeMinutes.get(key)?.minutes || 0) < minutes(row.runtime)) episodeMinutes.set(key, { series: identity(item), label: item.title, minutes: minutes(row.runtime) });
    if (reviewed(row)) add('review', key, label);
  }
  const seriesMinutes = new Map<string, { label: string; minutes: number }>();
  for (const row of episodeMinutes.values()) {
    const total = seriesMinutes.get(row.series) || { label: row.label, minutes: 0 };
    total.minutes += row.minutes;
    seriesMinutes.set(row.series, total);
  }
  for (const [key, row] of seriesMinutes) add('episodeHour', key, row.label, Math.floor(row.minutes / 60));
  for (const award of awards) add('achievement', award.key, award.name);
  return [...result.values()];
}
