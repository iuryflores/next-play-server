import { randomUUID } from 'node:crypto';
import type { Connection } from 'mongoose';
import { rankingChanges, type RankingSet } from './ranking-snapshot';
import { stablePositions } from './ranking-order';

const pending = new Map<string, Promise<unknown>>();
export async function compareRankingVisit(connection: Connection, owner: string, scope: string, visit: string | undefined, ranks: RankingSet, preserveTies = false) {
  const visitId = visit && /^[a-zA-Z0-9-]{1,100}$/.test(visit) ? visit : randomUUID();
  const id = `${owner}:${scope}`;
  const lockKey = `${connection.name}:${id}`;
  const task = (pending.get(lockKey) || Promise.resolve()).catch(() => {}).then(async () => {
    const collection = connection.collection<{ _id: string; version?: number; visitId: string; ranks: RankingSet; baseline: RankingSet | null; updatedAt: Date }>('ranking_visits');
    const saved = await collection.findOne({ _id: id });
    const previousRanks = saved ? saved.version === 2 ? saved.ranks : stablePositions(saved.ranks, saved.baseline || {}) : null;
    const baseline = saved?.version === 2 && saved.visitId === visitId ? saved.baseline : previousRanks;
    // Rankings por XP compartilham a posição nos empates; rankings pessoais
    // continuam com posições individuais estáveis para comparar preferências.
    const ordered = preserveTies ? ranks : stablePositions(ranks, previousRanks || {});
    const updatedAt = new Date();
    await collection.updateOne({ _id: id }, { $set: { version: 2, visitId, ranks: ordered, baseline, updatedAt } }, { upsert: true });
    return { rankingChanges: baseline ? rankingChanges(baseline, ordered) : {}, rankingPositions: ordered, rankingUpdatedAt: updatedAt };
  });
  pending.set(lockKey, task);
  try { return await task; } finally { if (pending.get(lockKey) === task) pending.delete(lockKey); }
}
