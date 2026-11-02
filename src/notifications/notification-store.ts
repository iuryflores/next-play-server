import { Connection, Types } from 'mongoose';

export type NotificationRecord = {
  ownerId: Types.ObjectId;
  kind: 'achievement' | 'friend-request' | 'comment-reply';
  sourceId: string;
  createdAt: Date;
  readAt?: Date;
  senderId?: string;
};

export async function saveNotification(connection: Connection, record: NotificationRecord) {
  // A chave do evento evita duplicações em sincronizações concorrentes e preserva a leitura.
  try {
    await connection.collection<NotificationRecord>('user_notifications').updateOne(
      { ownerId: record.ownerId, kind: record.kind, sourceId: record.sourceId },
      { $setOnInsert: record }, { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
}
