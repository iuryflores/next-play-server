import { Connection, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';

export type SocialSettings = { _id: Types.ObjectId; publicProfile?: boolean; shareActivity?: boolean; backlogAlerts?: boolean; favoriteIds?: string[]; shareSince?: Date };
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
    if (!item || item.archived || typeof item.catalogKey !== 'string') return;
    const profile = await connection.collection<SocialSettings>('social_profiles').findOne({ _id: item.ownerId, shareActivity: true });
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
    await connection.collection<SocialActivity>('social_activity').updateOne({ sourceKey }, { $setOnInsert: { _id: new Types.ObjectId(), ownerId: item.ownerId, itemId, type, recordedAt, sourceKey, recipientIds } }, { upsert: true });
  } catch {
    // Falha na camada social não desfaz um acompanhamento já salvo com sucesso.
    console.warn('[Social] Não foi possível registrar uma atividade.');
  }
}
