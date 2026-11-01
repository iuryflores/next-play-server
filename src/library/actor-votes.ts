type CastMember = { id: string; actor: string; character: string; photo: string };
export type CastCache = { _id: string; cast: CastMember[] };
type VoteSource = { itemId: string; title: string; kind: string; count: number };
export type Vote = { itemId?: string; title?: string; favoriteActorId?: string; favoriteActorName?: string; favoriteActorPhoto?: string; favoriteCastId?: string; catalogId?: string; kind: string; name: string; season?: number; episode?: number };
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');

export function actorVotes(votes: Vote[], caches: CastCache[]) {
  const actors = new Map<string, { id: string; name: string; photo: string; kind: string; count: number; sources: VoteSource[] }>();
  const unmatched: Record<string, number> = {};
  for (const vote of votes) {
    const resolved = vote.favoriteActorId && vote.favoriteActorName
      ? { id: vote.favoriteActorId, name: vote.favoriteActorName, photo: vote.favoriteActorPhoto || '' }
      : resolveActor(vote, caches);
    if (!resolved) { unmatched[vote.kind] = (unmatched[vote.kind] || 0) + 1; continue; }
    const { id } = resolved;
    const key = `${vote.kind}:${id}`;
    const actor = actors.get(key) || { id, name: resolved.name, photo: resolved.photo, kind: vote.kind, count: 0, sources: [] as VoteSource[] };
    if (vote.itemId && vote.title) {
      const source = actor.sources.find(source => source.itemId === vote.itemId);
      if (source) source.count++;
      else actor.sources.push({ itemId: vote.itemId, title: vote.title, kind: vote.kind, count: 1 });
    }
    actor.count++; actors.set(key, actor);
  }
  return { actors: [...actors.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), unmatchedActorVotes: unmatched };
}

export function resolveActor(vote: Vote, caches: CastCache[]) {
  const titleCaches = vote.catalogId ? caches.filter(cache => cache._id.startsWith(vote.catalogId + ':')) : [];
  const context = vote.season !== undefined && vote.episode !== undefined ? `:${vote.season}:${vote.episode}` : ':all:all';
  const match = (entries: CastCache[]) => entries.flatMap(cache => cache.cast).filter(member => normalize(member.character) === normalize(vote.name));
  const exact = match(titleCaches.filter(cache => cache._id.endsWith(context)));
  const candidates = vote.favoriteCastId ? match(titleCaches).filter(member => member.id === vote.favoriteCastId) : exact.length ? exact : match(titleCaches);
  const people = new Map(candidates.filter(member => /^\d+:/.test(member.id)).map(member => [member.id.split(':')[0], member]));
  if (people.size !== 1) return undefined;
  const [id, member] = [...people][0];
  return { id, name: member.actor, photo: member.photo, castId: member.id };
}
