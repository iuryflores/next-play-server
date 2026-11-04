import { Connection, Types } from 'mongoose';
export type RankingSummary = { minutes: number; episodes: number; missingRuntime: number; pendingSeries: number };

export async function rankingSummaries(connection: Connection, owners: string[]) {
  const totals = new Map<string, RankingSummary>(owners.map(owner => [owner, { minutes: 0, episodes: 0, missingRuntime: 0, pendingSeries: 0 }]));
  if (!owners.length) return totals;
  // Três leituras para todo o grupo; avaliações, elenco, gêneros e produtoras não participam deste resumo.
  const series = await connection.collection<{ _id: Types.ObjectId; ownerId: Types.ObjectId; catalogId?: string; status: string; episodesCompletedAt?: Date }>('library_items').find({ ownerId: { $in: owners.map(owner => new Types.ObjectId(owner)) }, kind: 'series' }, { projection: { ownerId: 1, catalogId: 1, status: 1, episodesCompletedAt: 1 } }).toArray();
  if (!series.length) return totals;
  const [progress, seasons] = await Promise.all([
    connection.collection<{ itemId: Types.ObjectId; season: number; episode: number }>('episode_progress').find({ itemId: { $in: series.map(item => item._id) } }, { projection: { itemId: 1, season: 1, episode: 1 } }).toArray(),
    connection.collection<{ catalogId: string; number: number; episodes?: { number: number; runtime?: number | null }[] }>('series_seasons').find({ catalogId: { $in: [...new Set(series.map(item => item.catalogId).filter((id): id is string => Boolean(id)))] } }, { projection: { catalogId: 1, number: 1, 'episodes.number': 1, 'episodes.runtime': 1 } }).toArray(),
  ]);
  const byId = new Map(series.map(item => [item._id.toString(), item]));
  const runtimes = new Map(seasons.flatMap(season => (season.episodes || []).map(episode => [`${season.catalogId}:${season.number}:${episode.number}`, episode.runtime] as const)));
  for (const item of series) if (item.status === 'completed' && (!item.catalogId || !item.episodesCompletedAt)) totals.get(item.ownerId.toString())!.pendingSeries++;
  // Preserva a regra anterior: episódios e minutos informativos usam a primeira visualização, inclusive especiais.
  for (const row of progress) {
    const item = byId.get(row.itemId.toString());
    if (!item) continue;
    const total = totals.get(item.ownerId.toString())!;
    total.episodes++;
    const runtime = runtimes.get(`${item.catalogId}:${row.season}:${row.episode}`);
    if (typeof runtime === 'number' && runtime > 0) total.minutes += runtime;
    else total.missingRuntime++;
  }
  return totals;
}
