import { BadRequestException } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { resolveActor, type CastCache } from './actor-votes';

export const emptyVoteIdentity = { favoriteCastId: '', favoriteActorId: '', favoriteActorName: '', favoriteActorPhoto: '' };
export async function voteIdentity(connection: Connection, catalogId: string | undefined, name: string, castId?: string, season?: number, episode?: number) {
  if (!name.trim()) return { ...emptyVoteIdentity };
  if (!catalogId || !/^tmdb:(movie|series):[0-9]+$/.test(catalogId)) {
    if (castId) throw new BadRequestException('Personagem inválido para este título.');
    return { ...emptyVoteIdentity };
  }
  const caches = await connection.collection<CastCache>('catalog_cast').find({ _id: { $regex: '^' + catalogId + ':' } }).toArray();
  const actor = resolveActor({ catalogId, name, kind: '', favoriteCastId: castId, season, episode }, caches);
  if (castId && !actor) throw new BadRequestException('Personagem não encontrado no elenco. Atualize o elenco e tente novamente.');
  return actor ? { favoriteCastId: actor.castId, favoriteActorId: actor.id, favoriteActorName: actor.name, favoriteActorPhoto: actor.photo } : { ...emptyVoteIdentity };
}
