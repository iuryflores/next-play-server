import { friendSources, SocialActivity, SocialSettings } from '../social/social-store';
import { commentAuthor } from '../community/comment-author';
import { BadRequestException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, OnModuleInit, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Connection, Types } from 'mongoose';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { AvatarStorage } from '../auth/avatar-storage';
import { getConfig } from '../config';
import { achievements } from '../achievements/achievement-rules';
import { NotificationRecord, saveNotification } from './notification-store';

class NotificationQuery {
  @ApiProperty({ required: false, maxLength: 300, description: 'Cursor opaco nextCursor da página anterior. Até 30 registros por página.' })
  @IsOptional() @IsString() @MaxLength(300) cursor?: string;
}
class AchievementNotice {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() family!: string;
  @ApiProperty() description!: string;
  @ApiProperty() target!: number;
  @ApiProperty({ type: [String], description: 'Evidência privada salva no desbloqueio.' }) evidence!: string[];
}
class FriendNotice {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Foto pública ou string vazia; nunca retorna email.' }) avatar!: string;
  @ApiProperty({ enum: ['pending', 'accepted', 'closed'] }) status!: string;
}
class CommentReplyNotice {
  @ApiProperty() available!: boolean;
  @ApiProperty() author!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) itemId!: string | null;
  @ApiProperty({ type: String, nullable: true }) parentCommentId!: string | null;
  @ApiProperty({ description: 'Trecho público de até 160 caracteres, vazio quando a resposta não está mais disponível.' }) excerpt!: string;
}
class FriendActivityNotice {
  @ApiProperty() available!: boolean;
  @ApiProperty() name!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) itemId!: string | null;
}
class NotificationDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['achievement', 'friend-request', 'comment-reply', 'friend-activity'] }) kind!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) readAt!: string | null;
  @ApiProperty({ type: AchievementNotice, nullable: true }) achievement!: AchievementNotice | null;
  @ApiProperty({ type: FriendNotice, nullable: true }) friendRequest!: FriendNotice | null;
  @ApiProperty({ type: CommentReplyNotice, nullable: true }) commentReply!: CommentReplyNotice | null;
  @ApiProperty({ type: FriendActivityNotice, nullable: true }) friendActivity!: FriendActivityNotice | null;
}
class NotificationsDto {
  @ApiProperty({ type: [NotificationDto] }) items!: NotificationDto[];
  @ApiProperty({ description: 'Total de não lidas em todas as páginas.' }) unreadCount!: number;
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection, private readonly avatars: AvatarStorage) {}
  private records() { return this.connection.collection<NotificationRecord>('user_notifications'); }
  async onModuleInit() {
    await this.records().createIndex({ ownerId: 1, kind: 1, sourceId: 1 }, { unique: true });
    await this.records().createIndex({ ownerId: 1, createdAt: -1, _id: -1 });
  }
  private async activityNotice(ownerId: Types.ObjectId, sourceId: string, sources: Awaited<ReturnType<typeof friendSources>>) {
    const hidden = { available: false, name: '', title: '', itemId: null as string | null };
    const event = await this.connection.collection<SocialActivity>('social_activity').findOne({ _id: new Types.ObjectId(sourceId), recipientIds: ownerId, type: 'completed' });
    if (!event || !sources.some(source => source.ownerId.equals(event.ownerId) && event.recordedAt >= source.since)) return hidden;
    const sourceItem = await this.connection.collection('library_items').findOne({ _id: event.itemId, ownerId: event.ownerId, archived: { $ne: true } });
    if (!sourceItem) return hidden;
    const item = await this.connection.collection('library_items').findOne({ ownerId, catalogKey: sourceItem.catalogKey, archived: { $ne: true } }, { projection: { title: 1 } });
    if (!item) return hidden;
    const actor = await this.connection.collection('users').findOne({ _id: event.ownerId }, { projection: { displayName: 1 } });
    return { available: true, name: actor?.displayName || 'Player', title: item.title, itemId: item._id.toString() };
  }
  private async reconcile(ownerId: Types.ObjectId) {
    // Recupera o histórico anterior à central e eventos cujo salvamento foi interrompido.
    // Não altera readAt nem transforma uma celebração dispensada em notificação lida.
    const [awards, requests, replies] = await Promise.all([
      this.connection.collection('achievement_awards').find({ ownerId }).toArray(),
      this.connection.collection('friendships').find({ receiver: ownerId.toString(), status: 'pending' }).toArray(),
      this.connection.collection('title_comments').find({ replyToOwnerId: ownerId, deleted: { $ne: true } }).toArray(),
    ]);
    const sources = await friendSources(this.connection, ownerId.toString());
    const settings = await this.connection.collection<SocialSettings>('social_profiles').findOne({ _id: ownerId });
    const activities = sources.length && settings?.backlogAlerts !== false ? await this.connection.collection<SocialActivity>('social_activity').find({ type: 'completed', recipientIds: ownerId, $or: sources.map(source => ({ ownerId: source.ownerId, recordedAt: { $gte: source.since } })) }).toArray() : [];
    await Promise.all(activities.map(async event => {
      if ((await this.activityNotice(ownerId, event._id.toString(), sources)).available) await saveNotification(this.connection, { ownerId, kind: 'friend-activity', sourceId: event._id.toString(), senderId: event.ownerId.toString(), createdAt: event.recordedAt });
    }));
    await Promise.all([
      ...awards.filter(row => achievements.some(item => item.id === row.key)).map(row => saveNotification(this.connection, { ownerId, kind: 'achievement', sourceId: row.key, createdAt: row.unlockedAt })),
      ...requests.map(row => saveNotification(this.connection, { ownerId, kind: 'friend-request', sourceId: row._id.toString(), senderId: row.sender, createdAt: row.createdAt })),
      ...replies.map(row => saveNotification(this.connection, { ownerId, kind: 'comment-reply', sourceId: row._id.toString(), senderId: row.ownerId.toString(), createdAt: row.createdAt })),
    ]);
  }
  async list(owner: string, cursor?: string) {
    const ownerId = new Types.ObjectId(owner);
    let boundary;
    if (cursor) {
      try {
        const [date, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (typeof date !== 'string' || !Number.isFinite(Date.parse(date)) || typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw Error();
        boundary = { $or: [{ createdAt: { $lt: new Date(date) } }, { createdAt: new Date(date), _id: { $lt: new Types.ObjectId(id) } }] };
      } catch { throw new BadRequestException('Cursor inválido.'); }
    }
    await this.reconcile(ownerId);
    const [rows, unreadCount] = await Promise.all([
      this.records().find({ ownerId, ...boundary }).sort({ createdAt: -1, _id: -1 }).limit(31).toArray(),
      this.records().countDocuments({ ownerId, readAt: { $exists: false } }),
    ]);
    const page = rows.slice(0, 30);
    const sources = await friendSources(this.connection, owner);
    const items = await Promise.all(page.map(async row => {
      let achievement = null, friendRequest = null, commentReply = null, friendActivity = null;
      if (row.kind === 'achievement') {
        const definition = achievements.find(item => item.id === row.sourceId);
        const award = await this.connection.collection('achievement_awards').findOne({ ownerId, key: row.sourceId });
        if (definition && award) achievement = { id: definition.id, family: definition.family, name: definition.name, description: definition.description, target: definition.target, evidence: award.evidence || [] };
      } else if (row.kind === 'friend-request') {
        const [user, request] = await Promise.all([
          this.connection.collection('users').findOne({ _id: new Types.ObjectId(row.senderId) }, { projection: { displayName: 1, avatar: 1, avatarKey: 1 } }),
          this.connection.collection('friendships').findOne({ _id: new Types.ObjectId(row.sourceId), receiver: owner, sender: row.senderId }),
        ]);
        friendRequest = { id: row.sourceId, name: user?.displayName || 'Player', avatar: user?.avatarKey ? await this.avatars.signedUrl(user.avatarKey).catch(() => '') : user?.avatar || '', status: request?.status === 'pending' ? 'pending' : request?.status === 'accepted' ? 'accepted' : 'closed' };
      }
      if (row.kind === 'comment-reply') {
        const reply = await this.connection.collection('title_comments').findOne({ _id: new Types.ObjectId(row.sourceId), replyToOwnerId: ownerId, deleted: { $ne: true } });
        const item = reply ? await this.connection.collection('library_items').findOne({ ownerId, catalogKey: reply.catalogKey }, { projection: { title: 1 } }) : null;
        const parent = reply ? await this.connection.collection('title_comments').findOne({ _id: reply.parentId, ownerId, catalogKey: reply.catalogKey }, { projection: { _id: 1 } }) : null;
        // Remoção da resposta ou perda de acesso ao título retira trecho e destino da notificação.
        const available = Boolean(reply && item && parent);
        commentReply = { available, author: available ? commentAuthor(reply!.catalogKey, reply!.ownerId.toString()) : '', title: available ? item!.title : '', itemId: available ? item!._id.toString() : null, parentCommentId: available ? parent!._id.toString() : null, excerpt: available ? String(reply!.text).slice(0, 160) : '' };
      }
      if (row.kind === 'friend-activity') friendActivity = await this.activityNotice(ownerId, row.sourceId, sources);
      return { id: row._id.toString(), kind: row.kind, createdAt: row.createdAt, readAt: row.readAt || null, achievement, friendRequest, commentReply, friendActivity };
    }));
    const last = page.at(-1);
    return { items, unreadCount, nextCursor: rows.length > 30 && last ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last._id.toString()])).toString('base64url') : null };
  }
  async read(owner: string, id: string) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new NotFoundException('Notificação não encontrada.');
    const filter = { _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(owner) };
    if (!await this.records().findOne(filter)) throw new NotFoundException('Notificação não encontrada.');
    await this.records().updateOne({ ...filter, readAt: { $exists: false } }, { $set: { readAt: new Date() } });
  }
  async readAll(owner: string) {
    await this.reconcile(new Types.ObjectId(owner));
    await this.records().updateMany({ ownerId: new Types.ObjectId(owner), readAt: { $exists: false } }, { $set: { readAt: new Date() } });
  }
}

@ApiTags('notifications') @ApiCookieAuth('session')
@ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
@Controller('notifications')
class NotificationsController {
  constructor(private readonly service: NotificationsService, private readonly auth: AuthService) {}
  private async owner(request: Request) {
    if (request.method !== 'GET' && request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem da requisição não permitida.');
    return (await this.auth.forRequest(request)).id;
  }
  @Get() @ApiOperation({ summary: 'Consultar notificações privadas', description: 'Inclui conquistas, convites recebidos e respostas de outras pessoas aos próprios comentários. Respostas usam pseudônimo por título, trecho público e destino privado para o item da conta; removidas ou sem acesso retornam available=false sem trecho/destino. Inclui também conclusões de amigos compartilhadas após aceite, quando o título já estava no backlog do destinatário no registro. Respeita as opções sociais, amizade atual e acesso ao título. Não notifica curtidas nem respostas a si mesmo. Ordena do evento mais recente para o mais antigo. Consultar não marca como lida. Convites encerrados permanecem no histórico; status é atualizado na consulta. Evidências são exclusivas do dono.' })
  @ApiOkResponse({ type: NotificationsDto })
  @ApiResponse({ status: 400, description: 'Cursor inválido ou campos não permitidos.' })
  async list(@Req() request: Request, @Query() query: NotificationQuery) { return this.service.list(await this.owner(request), query.cursor); }
  @Patch(':id/read') @HttpCode(204)
  @ApiOperation({ summary: 'Marcar uma notificação como lida', description: 'Idempotente. Não confirma nem dispensa a celebração da conquista.' })
  @ApiResponse({ status: 204, description: 'Leitura salva.' })
  @ApiResponse({ status: 404, description: 'Notificação inexistente ou de outra conta.' })
  @ApiResponse({ status: 403, description: 'Origem não permitida.' })
  async read(@Req() request: Request, @Param('id') id: string) { await this.service.read(await this.owner(request), id); }
  @Post('read-all') @HttpCode(204)
  @ApiOperation({ summary: 'Marcar todas as notificações atuais como lidas', description: 'Inclui todas as páginas da conta. Não afeta celebrações ou notificações futuras.' })
  @ApiResponse({ status: 204, description: 'Leituras salvas.' })
  @ApiResponse({ status: 403, description: 'Origem não permitida.' })
  async readAll(@Req() request: Request) { await this.service.readAll(await this.owner(request)); }
}
@Module({ imports: [AuthModule], providers: [NotificationsService], controllers: [NotificationsController] })
export class NotificationsModule {}
