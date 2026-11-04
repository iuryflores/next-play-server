import { saveNotification } from '../notifications/notification-store';
import { Connection, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {recordPrivateActivity} from '../library/activity-history';

export type SocialSettings = { _id: Types.ObjectId; publicProfile?: boolean; shareActivity?: boolean; backlogAlerts?: boolean; favoriteIds?: string[]; shareSince?: Date; bio?: string; tastes?: string; favoriteActors?: string[]; favoriteDirectors?: string[]; favoriteAuthors?: string[]; shareComparison?: boolean; shareFollowers?: boolean; followersSince?: Date; isCritic?: boolean };
export async function activitySources(connection: Connection, viewer: string) {
  const friends = await friendSources(connection, viewer);
  const follows = await connection.collection('social_follows').find({ ownerId: new Types.ObjectId(viewer) }).toArray();
  const profiles = await connection.collection<SocialSettings>('social_profiles').find({ _id: { $in: follows.map(row => row.targetId) }, publicProfile: true, shareFollowers: true }).toArray();
  // Seguir não equivale a amizade: o autor opta separadamente por publicar aos seguidores.
  const merged = new Map(friends.map(source => [source.ownerId.toString(), source]));
  for (const profile of profiles) {
    const since = new Date(Math.max(new Date(profile.followersSince || 0).getTime(), new Date(follows.find(row => row.targetId.equals(profile._id))?.createdAt || 0).getTime()));
    const old = merged.get(profile._id.toString());
    if (!old || since < old.since) merged.set(profile._id.toString(), { ownerId: profile._id, since });
  }
  return [...merged.values()];
}
export type SocialActivity = { _id: Types.ObjectId; ownerId: Types.ObjectId; itemId: Types.ObjectId; type: 'added' | 'started' | 'completed'; recordedAt: Date; sourceKey: string; recipientIds: Types.ObjectId[] };
export async function friendSources(connection: Connection, viewer: string) {
  const links = await connection.collection('friendships').find({ status: 'accepted', $or: [{ sender: viewer }, { receiver: viewer }] }).toArray();
  const ids = links.map(link => new Types.ObjectId(link.sender === viewer ? link.receiver : link.sender));
  const settings = await connection.collection<SocialSettings>('social_profiles').find({ _id: { $in: ids }, shareActivity: true }).toArray();
  return settings.map(setting => {
    const link = links.find(link => link.sender === setting._id.toString() || link.receiver === setting._id.toString())!;
    // Um novo compartilhamento ou amizade não publica retroativamente atividades antigas.
    return { ownerId: setting._id, since: new Date(Math.max(new Date(setting.shareSince || 0).getTime(), new Date(link.updatedAt || link.createdAt || 0).getTime())) };
  });
}
export async function recordSocialActivity(connection: Connection, itemId: Types.ObjectId, type: SocialActivity['type'], sourceKey: string = randomUUID()) {
  try {
    const item = await connection.collection('library_items').findOne({ _id: itemId });
    if(item)await recordPrivateActivity(connection,item as any,type,sourceKey);
    if (!item || item.archived || typeof item.catalogKey !== 'string') return;
    const profile = await connection.collection<SocialSettings>('social_profiles').findOne({ _id: item.ownerId, $or: [{ shareActivity: true }, { publicProfile: true, shareFollowers: true }] });
    if (!profile) return;
    const recordedAt = new Date();
    let recipientIds: Types.ObjectId[] = [];
    if (type === 'completed') {
      const links = await connection.collection('friendships').find({ status: 'accepted', $or: [{ sender: item.ownerId.toString() }, { receiver: item.ownerId.toString() }] }).toArray();
      const friends = links.map(link => new Types.ObjectId(link.sender === item.ownerId.toString() ? link.receiver : link.sender));
      const disabled = await connection.collection<SocialSettings>('social_profiles').find({ _id: { $in: friends }, backlogAlerts: false }).toArray();
      const allowed = friends.filter(id => !disabled.some(row => row._id.equals(id)));
      const matches = await connection.collection('library_items').find({ ownerId: { $in: allowed }, catalogKey: item.catalogKey, archived: { $ne: true }, $or: [{ status: 'planned' }, { rewatchWanted: true }] }, { projection: { ownerId: 1 } }).toArray();
      recipientIds = [...new Map(matches.map(row => [row.ownerId.toString(), row.ownerId])).values()];
    }
    // A data registra a ação no app, nunca inventa o dia em que uma importação foi consumida.
    const saved = await connection.collection<SocialActivity>('social_activity').updateOne({ sourceKey }, { $setOnInsert: { _id: new Types.ObjectId(), ownerId: item.ownerId, itemId, type, recordedAt, sourceKey, recipientIds } }, { upsert: true });
    // O sino consulta apenas o contador; novos avisos são persistidos junto do evento, sem depender de uma leitura posterior.
    if (saved.upsertedId && type === 'completed') await Promise.all(recipientIds.map(ownerId => saveNotification(connection, { ownerId, kind: 'friend-activity', sourceId: saved.upsertedId!.toString(), senderId: item.ownerId.toString(), createdAt: recordedAt })));
  } catch {
    // Falha na camada social não desfaz um acompanhamento já salvo com sucesso.
    console.warn('[Social] Não foi possível registrar uma atividade.');
  }
}
