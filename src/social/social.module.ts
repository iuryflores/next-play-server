import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, OnModuleInit, Param, Patch, Query, Req } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, Matches, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { AvatarStorage } from '../auth/avatar-storage';
import { getConfig } from '../config';
import { ProgressionModule, ProgressionService } from '../progression/progression.module';
import { levelFromXp } from '../progression/progression-rules';
import { achievements } from '../achievements/achievement-rules';
import { friendSources, SocialSettings, SocialActivity } from './social-store';
class SocialSettingsDto {
  @ApiProperty({ required: false, type: Boolean, description: 'Padrão false: perfil visível somente ao dono. true publica concluídos não arquivados e Top 4 para usuários autenticados. Não publica notas/anotações.' })
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() publicProfile?: boolean;
  @ApiProperty({ required: false, type: Boolean, description: 'Padrão false. Compartilha somente novas ações com amigos aceitos; reativar reinicia o período visível, sem histórico retroativo.' })
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() shareActivity?: boolean;
  @ApiProperty({ required: false, type: Boolean, description: 'Padrão true: receber avisos de conclusões de amigos que compartilham atividades e de títulos já presentes no backlog naquele momento.' })
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() backlogAlerts?: boolean;
  @ApiProperty({ required: false, type: [String], maxItems: 4, description: 'Até quatro IDs distintos de títulos próprios, concluídos e não arquivados, na ordem desejada. Não inclui acervo possuído nem episódios.' })
  @Transform(({ value }) => Array.isArray(value) ? value.map(id => typeof id === 'string' ? id.toLowerCase() : id) : value)
  @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMaxSize(4) @ArrayUnique() @Matches(/^[a-f0-9]{24}$/, { each: true }) favoriteIds?: string[];
}
@Injectable()
export class SocialService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection, private readonly avatars: AvatarStorage, private readonly progression: ProgressionService) {}
  async onModuleInit() {
    await this.connection.collection('social_activity').createIndex({ sourceKey: 1 }, { unique: true });
    await this.connection.collection('social_activity').createIndex({ ownerId: 1, _id: -1 });
    await this.connection.collection('social_activity').createIndex({ recipientIds: 1, _id: -1 });
  }
  private id(id: string) { if (!/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestException('Identificador inválido.'); return new Types.ObjectId(id); }
  async settings(owner: string) {
    const row = await this.connection.collection<SocialSettings>('social_profiles').findOne({ _id: this.id(owner) });
    return { publicProfile: row?.publicProfile === true, shareActivity: row?.shareActivity === true, backlogAlerts: row?.backlogAlerts !== false, favoriteIds: row?.favoriteIds || [] };
  }
  async save(owner: string, dto: SocialSettingsDto) {
    const ownerId = this.id(owner);
    if (dto.favoriteIds?.length) {
      const picked = await this.connection.collection('library_items').find({ _id: { $in: dto.favoriteIds.map(id => this.id(id)) }, ownerId, status: 'completed', archived: { $ne: true } }, { projection: { catalogKey: 1 } }).toArray();
      if (picked.length !== dto.favoriteIds.length || new Set(picked.map(row => row.catalogKey || row._id.toString())).size !== dto.favoriteIds.length) throw new BadRequestException('Escolha até quatro títulos seus, concluídos e não arquivados.');
    }
    const previous = await this.settings(owner);
    // Campos ausentes não podem virar null e apagar escolhas de outra atualização.
    const partial = Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined));
    const changes = { ...partial, ...(dto.shareActivity === true && !previous.shareActivity ? { shareSince: new Date() } : {}) };
    await this.connection.collection<SocialSettings>('social_profiles').updateOne({ _id: ownerId }, { $set: changes }, { upsert: true });
    return this.settings(owner);
  }
  private async titles(viewer: string, rows: Record<string, any>[]) {
    const own = await this.connection.collection('library_items').find({ ownerId: this.id(viewer), catalogKey: { $in: rows.map(row => row.catalogKey) } }, { projection: { catalogKey: 1 } }).toArray();
    // IDs da biblioteca de outra pessoa e avaliações individuais não são públicos.
    return rows.map(row => ({ key: row.catalogKey, title: row.title, kind: row.kind, coverUrl: row.coverUrl || '', year: row.year || '', catalogId: row.catalogId || null, viewerItemId: own.find(item => item.catalogKey === row.catalogKey)?._id.toString() || null }));
  }
  async profile(viewer: string, id: string, before?: string) {
    const ownerId = this.id(id), own = viewer === ownerId.toString();
    const setting = await this.settings(id);
    if (!own && !setting.publicProfile) throw new NotFoundException('Perfil privado ou não encontrado.');
    const user = await this.connection.collection('users').findOne({ _id: ownerId }, { projection: { displayName: 1, avatar: 1, avatarKey: 1 } });
    if (!user) throw new NotFoundException('Perfil não encontrado.');
    await this.progression.recognize(id);
    const credits = await this.connection.collection('user_xp_credits').aggregate<{ xp: number }>([{ $match: { ownerId } }, { $group: { _id: null, xp: { $sum: { $multiply: ['$units', '$rate'] } } } }]).toArray();
    const base = { ownerId, status: 'completed', archived: { $ne: true } };
    // Legados duplicados não repetem títulos nem alteram a contagem pública.
    const distinct = [{ $match: base }, { $sort: { updatedAt: -1, _id: -1 } }, { $group: { _id: { $ifNull: ['$catalogKey', { $toString: '$_id' }] }, item: { $first: '$$ROOT' } } }, { $replaceRoot: { newRoot: '$item' } }];
    const rows = await this.connection.collection('library_items').aggregate([...distinct, ...(before ? [{ $match: { _id: { $lt: this.id(before) } } }] : []), { $sort: { _id: -1 } }, { $limit: 31 }]).toArray();
    const count = await this.connection.collection('library_items').aggregate([...distinct, { $count: 'count' }]).toArray();
    const favorites = setting.favoriteIds.length ? await this.connection.collection('library_items').find({ ...base, _id: { $in: setting.favoriteIds.map(id => this.id(id)) } }).toArray() : [];
    const ordered = setting.favoriteIds.map(id => favorites.find(row => row._id.toString() === id)).filter(row => row !== undefined);
    const selected = await this.connection.collection('achievement_profiles').findOne({ ownerId });
    const award = selected?.selectedId ? await this.connection.collection('achievement_awards').findOne({ ownerId, key: selected.selectedId }) : null;
    const badge = award ? achievements.find(row => row.id === award.key) : null;
    return { id: ownerId.toString(), mine: own, published: setting.publicProfile, name: user.displayName || 'Player', avatar: user.avatarKey ? await this.avatars.signedUrl(user.avatarKey).catch(() => '') : user.avatar || '', ...levelFromXp(credits[0]?.xp || 0), achievement: badge ? { title: badge.title, family: badge.family } : null, totalCompleted: count[0]?.count || 0, favorites: await this.titles(viewer, ordered), completed: await this.titles(viewer, rows.slice(0, 30)), nextBefore: rows.length > 30 ? rows[29]._id.toString() : null };
  }
  async feed(viewer: string, before?: string) {
    const boundary = before ? this.id(before) : null;
    const sources = await friendSources(this.connection, viewer);
    if (!sources.length) return { activities: [], nextBefore: null };
    const rows = await this.connection.collection<SocialActivity>('social_activity').aggregate([
      { $match: { $or: sources.map(source => ({ ownerId: source.ownerId, recordedAt: { $gte: source.since } })), ...(boundary ? { _id: { $lt: boundary } } : {}) } },
      { $sort: { _id: -1 } },
      { $lookup: { from: 'library_items', let: { item: '$itemId', owner: '$ownerId' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$_id', '$$item'] }, { $eq: ['$ownerId', '$$owner'] }] }, archived: { $ne: true } } }], as: 'title' } },
      { $unwind: '$title' }, { $limit: 31 },
    ]).toArray();
    const page = rows.slice(0, 30);
    const users = await this.connection.collection('users').find({ _id: { $in: page.map(row => row.ownerId) } }, { projection: { displayName: 1, avatar: 1, avatarKey: 1 } }).toArray();
    const profiles = await this.connection.collection<SocialSettings>('social_profiles').find({ _id: { $in: page.map(row => row.ownerId) } }).toArray();
    const titles = await this.titles(viewer, page.map(row => row.title));
    return { activities: await Promise.all(page.map(async (row, index) => {
      const user = users.find(user => user._id.equals(row.ownerId));
      return { id: row._id.toString(), type: row.type, recordedAt: row.recordedAt, title: titles[index], actor: { id: row.ownerId.toString(), name: user?.displayName || 'Player', avatar: user?.avatarKey ? await this.avatars.signedUrl(user.avatarKey).catch(() => '') : user?.avatar || '', profileAvailable: profiles.some(profile => profile._id.equals(row.ownerId) && profile.publicProfile) } };
    })), nextBefore: rows.length > 30 ? page[29]._id.toString() : null };
  }
}
@ApiTags('social') @ApiCookieAuth('session') @Controller('social')
class SocialController {
  constructor(private readonly service: SocialService, private readonly auth: AuthService) {}
  private async owner(request: Request) { if (request.method !== 'GET' && request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem não permitida.'); return (await this.auth.forRequest(request)).id; }
  @Get('settings') @ApiOperation({ summary: 'Consultar opções sociais privadas', description: 'Padrões: perfil privado, atividades não compartilhadas e alertas de backlog habilitados. Favoritos são privados até publicar o perfil.' })
  settings(@Req() request: Request) { return this.owner(request).then(owner => this.service.settings(owner)); }
  @Patch('settings') @ApiOperation({ summary: 'Alterar compartilhamento e Top 4', description: 'Atualização parcial persistida no MongoDB. Campos ausentes preservados. Publicar perfil e compartilhar atividades são escolhas independentes. Somente títulos próprios concluídos e não arquivados podem entrar no Top 4.' })
  async save(@Req() request: Request, @Body() dto: SocialSettingsDto) { return this.service.save(await this.owner(request), dto); }
  @Get('feed') @ApiOperation({ summary: 'Atividades novas dos amigos aceitos', description: 'Até 30 eventos por página: added, started, completed. Apenas ações registradas após habilitar compartilhamento e aceitar amizade. recordedAt é data de registro, não data real de consumo/importação. Arquivamento, exclusão, desativação do compartilhamento ou remoção da amizade ocultam eventos. Não retorna notas ou avaliações individuais.' })
  @ApiQuery({ name: 'before', required: false, type: String, description: 'nextBefore da página anterior.' })
  @ApiOkResponse({ description: 'activities: id, type, recordedAt, title (key/title/kind/coverUrl/year/catalogId/viewerItemId da sessão), actor (id/name/avatar/profileAvailable). nextBefore ou null.' })
  async feed(@Req() request: Request, @Query('before') before?: string) { return this.service.feed(await this.owner(request), before); }
  @Get('profiles/:id') @ApiOperation({ summary: 'Perfil de consumo publicado para usuários do app', description: 'Exige sessão. Perfil não publicado retorna 404 para outras pessoas; o dono pode pré-visualizar. Retorna foto/nome, XP/nível, título de conquista, Top 4 ordenado e até 30 títulos concluídos não arquivados. Não inclui acervo possuído, anotações, notas individuais, sessões ou episódios. nextBefore pagina concluídos.' })
  @ApiQuery({ name: 'before', required: false, type: String })
  async profile(@Req() request: Request, @Param('id') id: string, @Query('before') before?: string) { return this.service.profile(await this.owner(request), id, before); }
}
@Module({ imports: [AuthModule, ProgressionModule], providers: [SocialService], controllers: [SocialController] })
export class SocialModule {}
