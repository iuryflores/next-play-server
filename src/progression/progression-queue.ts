import { Connection, Types } from 'mongoose';

// A revisão permite reconhecer um retrato sem apagar uma mudança recebida durante o processamento.
export const XP_RULES_VERSION = 2;
export type XpJob = { _id: Types.ObjectId; revision: number; dirty: boolean; version: number; leaseUntil: Date; leaseToken?: string; syncedAt?: Date };
export async function markXpDirty(connection: Connection, owner: string) {
  const jobs = connection.collection<XpJob>('user_xp_sync');
  const id = new Types.ObjectId(owner);
  try {
    await jobs.updateOne({ _id: id }, { $inc: { revision: 1 }, $set: { dirty: true }, $setOnInsert: { version: 0, leaseUntil: new Date(0) } }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    await jobs.updateOne({ _id: id }, { $inc: { revision: 1 }, $set: { dirty: true } });
  }
}
