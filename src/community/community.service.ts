import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { commentAuthor } from './comment-author';
import { saveNotification } from '../notifications/notification-store';

type Comment = { _id: Types.ObjectId; catalogKey: string; ownerId: Types.ObjectId; text: string; createdAt: Date; parentId?: Types.ObjectId | null; replyToOwnerId?: Types.ObjectId; clientRequestId?: string; deleted?: boolean };
@Injectable()
export class CommunityService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private comments() { return this.connection.collection<Comment>('title_comments'); }
  private likes() { return this.connection.collection<{ commentId: Types.ObjectId; ownerId: Types.ObjectId }>('comment_likes'); }
  async onModuleInit() {
    await this.likes().createIndex({ commentId: 1, ownerId: 1 }, { unique: true });
    await this.comments().createIndex({ ownerId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
    await this.comments().createIndex({ catalogKey: 1, parentId: 1, _id: 1 });
    await this.comments().createIndex({ replyToOwnerId: 1, deleted: 1 });
  }
  private id(value: string) { if (!/^[a-f0-9]{24}$/i.test(value)) throw new BadRequestException('Comentário ou título inválido.'); return new Types.ObjectId(value); }
  private async owned(owner: string, id: string) {
    const item = await this.connection.collection('library_items').findOne({ _id: this.id(id), ownerId: new Types.ObjectId(owner) }, { projection: { catalogKey: 1 } });
    if (!item?.catalogKey) throw new NotFoundException('Título não encontrado.');
    return item;
  }
  private async target(key: string, id: string) {
    const comment = await this.comments().findOne({ _id: this.id(id), catalogKey: key });
    if (!comment) throw new NotFoundException('Comentário não encontrado.');
    return comment;
  }
  private async publicRows(owner: string, rows: Comment[]) {
    const ids = rows.map(row => row._id);
    const [likes, replies] = await Promise.all([
      this.likes().aggregate<{ _id: Types.ObjectId; count: number; liked: boolean }>([{ $match: { commentId: { $in: ids } } }, { $group: { _id: '$commentId', count: { $sum: 1 }, liked: { $max: { $eq: ['$ownerId', new Types.ObjectId(owner)] } } } }]).toArray(),
      this.comments().aggregate<{ _id: Types.ObjectId; count: number }>([{ $match: { parentId: { $in: ids } } }, { $group: { _id: '$parentId', count: { $sum: 1 } } }]).toArray(),
    ]);
    // Só contagem e estado da própria curtida saem da API; identidades dos demais ficam privadas.
    return rows.map(row => ({ id: row._id.toString(), parentId: row.parentId?.toString() || null, text: row.deleted ? '' : row.text, deleted: Boolean(row.deleted), createdAt: row.createdAt, mine: row.ownerId.toString() === owner, author: commentAuthor(row.catalogKey, row.ownerId.toString()), likeCount: row.deleted ? 0 : (likes.find(like => like._id.equals(row._id))?.count || 0), liked: !row.deleted && Boolean(likes.find(like => like._id.equals(row._id))?.liked), replyCount: replies.find(reply => reply._id.equals(row._id))?.count || 0 }));
  }
  async list(owner: string, id: string, before?: string) {
    const item = await this.owned(owner, id);
    const rows = await this.comments().find({ catalogKey: item.catalogKey, parentId: null, ...(before ? { _id: { $lt: this.id(before) } } : {}) }).sort({ _id: -1 }).limit(31).toArray();
    return { comments: await this.publicRows(owner, rows.slice(0, 30)), next: rows.length > 30 ? rows[29]._id.toString() : null };
  }
  async thread(owner: string, id: string, commentId: string, after?: string) {
    const item = await this.owned(owner, id), root = await this.target(item.catalogKey, commentId);
    if (root.parentId) throw new BadRequestException('Abra o comentário principal desta resposta.');
    const rows = await this.comments().find({ catalogKey: item.catalogKey, parentId: root._id, ...(after ? { _id: { $gt: this.id(after) } } : {}) }).sort({ _id: 1 }).limit(21).toArray();
    return { comment: (await this.publicRows(owner, [root]))[0], replies: await this.publicRows(owner, rows.slice(0, 20)), next: rows.length > 20 ? rows[19]._id.toString() : null };
  }
  async create(owner: string, id: string, dto: { text: string; clientRequestId?: string }, parentId?: string) {
    const item = await this.owned(owner, id), ownerId = new Types.ObjectId(owner);
    const parent = parentId ? await this.target(item.catalogKey, parentId) : null;
    if (parent && (parent.parentId || parent.deleted)) throw new BadRequestException('Responda a um comentário principal disponível.');
    let row: Comment = { _id: new Types.ObjectId(), ownerId, catalogKey: item.catalogKey, text: dto.text, createdAt: new Date(), ...(dto.clientRequestId ? { clientRequestId: dto.clientRequestId } : {}), ...(parent ? { parentId: parent._id, ...(parent.ownerId.equals(ownerId) ? {} : { replyToOwnerId: parent.ownerId }) } : {}) };
    try { await this.comments().insertOne(row); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000 || !dto.clientRequestId) throw error;
      const saved = await this.comments().findOne({ ownerId, clientRequestId: dto.clientRequestId });
      if (!saved || saved.deleted || saved.catalogKey !== item.catalogKey || saved.text !== dto.text || (saved.parentId?.toString() || '') !== (parent?._id.toString() || '')) throw new ConflictException('Esta publicação já foi usada com outros dados.');
      row = saved;
    }
    // A resposta persistida funciona como origem recuperável caso a notificação falhe depois.
    if (row.replyToOwnerId) await saveNotification(this.connection, { ownerId: row.replyToOwnerId, kind: 'comment-reply', sourceId: row._id.toString(), senderId: owner, createdAt: row.createdAt });
    const comment = (await this.publicRows(owner, [row]))[0];
    // O contador confirmado evita somar de novo na tela quando um POST é reenviado após timeout.
    return { ...comment, ...(parent ? { parentReplyCount: await this.comments().countDocuments({ parentId: parent._id }) } : {}) };
  }
  async like(owner: string, id: string, commentId: string, liked: boolean) {
    const item = await this.owned(owner, id), target = await this.target(item.catalogKey, commentId);
    if (target.deleted) throw new NotFoundException('Comentário removido.');
    const filter = { commentId: target._id, ownerId: new Types.ObjectId(owner) };
    if (liked) {
      try { await this.likes().updateOne(filter, { $setOnInsert: filter }, { upsert: true }); }
      catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    } else await this.likes().deleteOne(filter);
    if (!await this.comments().findOne({ _id: target._id, deleted: { $ne: true } })) { await this.likes().deleteOne(filter); throw new NotFoundException('Comentário removido.'); }
    return { liked, likeCount: await this.likes().countDocuments({ commentId: target._id }) };
  }
  async remove(owner: string, id: string, commentId: string) {
    const item = await this.owned(owner, id);
    // Mantém um marcador para não apagar respostas de outras pessoas nem deixar órfãos.
    const result = await this.comments().updateOne({ _id: this.id(commentId), catalogKey: item.catalogKey, ownerId: new Types.ObjectId(owner) }, { $set: { deleted: true, text: '' } });
    if (!result.matchedCount) throw new NotFoundException('Comentário não encontrado.');
    await this.likes().deleteMany({ commentId: this.id(commentId) });
  }
}
