import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, OnModuleInit, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsString, MaxLength, Matches, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { AvatarStorage } from '../auth/avatar-storage';
import { getConfig } from '../config';
import { ProgressionModule, ProgressionService } from '../progression/progression.module';
import { levelFromXp } from '../progression/progression-rules';
import { achievements } from '../achievements/achievement-rules';
import { activitySources, SocialSettings, SocialActivity } from './social-store';
class SocialSettingsDto {
  @ApiProperty({ required: false, description: 'Autoriza comparação agregada de gosto com amigos que também habilitaram esta opção. Não publica notas individuais.' })
  @ValidateIf((_o, value) => value !== undefined) @IsBoolean() shareComparison?: boolean;
  @ApiProperty({ required: false, description: 'Publica novas atividades para seguidores apenas enquanto o perfil estiver público; não inclui histórico anterior.' })
  @ValidateIf((_o, value) => value !== undefined) @IsBoolean() shareFollowers?: boolean;
  @ApiProperty({ required: false, description: 'Identificação de crítico autodeclarada, sem verificação editorial.' })
  @ValidateIf((_o, value) => value !== undefined) @IsBoolean() isCritic?: boolean;
  @ApiProperty({ required: false, maxLength: 500, description: 'Bio escrita pelo dono; publicada somente com o perfil.' })
  @ValidateIf((_o, value) => value !== undefined) @IsString() @MaxLength(500) bio?: string;
  @ApiProperty({ required: false, maxLength: 500, description: 'Preferências e gostos descritos pelo próprio usuário.' })
  @ValidateIf((_o, value) => value !== undefined) @IsString() @MaxLength(500) tastes?: string;
  @ApiProperty({ required: false, type: [String], maxItems: 10, description: 'Atores favoritos escolhidos explicitamente; até dez nomes de até 100 caracteres.' })
  @ValidateIf((_o, value) => value !== undefined) @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsString({ each: true }) @MaxLength(100, { each: true }) @Matches(/\S/, { each: true }) favoriteActors?: string[];
  @ApiProperty({ required: false, type: [String], maxItems: 10, description: 'Diretores favoritos escolhidos explicitamente, não inferidos dos votos.' })
  @ValidateIf((_o, value) => value !== undefined) @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsString({ each: true }) @MaxLength(100, { each: true }) @Matches(/\S/, { each: true }) favoriteDirectors?: string[];
  @ApiProperty({ required: false, type: [String], maxItems: 10, description: 'Autores favoritos escolhidos explicitamente, até dez nomes.' })
  @ValidateIf((_o, value) => value !== undefined) @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsString({ each: true }) @MaxLength(100, { each: true }) @Matches(/\S/, { each: true }) favoriteAuthors?: string[];
  @ApiProperty({ required: false, type: Boolean, description: 'Padrão false: perfil visível somente ao dono. true publica concluídos não arquivados e Top 10 para usuários autenticados. Não publica notas/anotações.' })
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() publicProfile?: boolean;
  @ApiProperty({ required: false, type: Boolean, description: 'Padrão false. Compartilha somente novas ações com amigos aceitos; reativar reinicia o período visível, sem histórico retroativo.' })
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() shareActivity?: boolean;
  @ApiProperty({ required: false, type: Boolean, description: 'Padrão true: receber avisos de conclusões de amigos que compartilham atividades e de títulos já presentes no backlog naquele momento.' })
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() backlogAlerts?: boolean;
  @ApiProperty({ required: false, type: [String], maxItems: 10, description: 'Até dez IDs distintos de títulos próprios não arquivados, na ordem desejada. Não inclui acervo possuído nem episódios.' })
  @Transform(({ value }) => Array.isArray(value) ? value.map(id => typeof id === 'string' ? id.toLowerCase() : id) : value)
  @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMaxSize(10) @ArrayUnique() @Matches(/^[a-f0-9]{24}$/, { each: true }) favoriteIds?: string[];
}
class FollowDto { @ApiProperty({ type: Boolean }) @IsBoolean() following!: boolean; }
class FavoriteDto { @ApiProperty({type:Boolean,description:'Estado desejado. Adicionar exige título próprio não arquivado; até dez favoritos. Remover sempre permite limpar a própria seleção.'}) @IsBoolean() favorite!:boolean; }
@Injectable()
export class SocialService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection, private readonly avatars: AvatarStorage, private readonly progression: ProgressionService) {}
  async onModuleInit() {
    await this.connection.collection('shared_titles').createIndex({ownerId:1,itemId:1},{unique:true});
    await this.connection.collection('social_follows').createIndex({ ownerId: 1, targetId: 1 }, { unique: true });
    await this.connection.collection('social_follows').createIndex({targetId:1,ownerId:1});
    await this.connection.collection('social_activity').createIndex({ sourceKey: 1 }, { unique: true });
    await this.connection.collection('social_activity').createIndex({ ownerId: 1, _id: -1 });
    await this.connection.collection('social_activity').createIndex({ recipientIds: 1, _id: -1 });
  }
  private id(id: string) { if (!/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestException('Identificador inválido.'); return new Types.ObjectId(id); }
  async settings(owner: string) {
    const row = await this.connection.collection<SocialSettings>('social_profiles').findOne({ _id: this.id(owner) });
    return { publicProfile: row?.publicProfile === true, shareActivity: row?.shareActivity === true, backlogAlerts: row?.backlogAlerts !== false, favoriteIds: row?.favoriteIds || [], bio: row?.bio || '', tastes: row?.tastes || '', favoriteActors: row?.favoriteActors || [], favoriteDirectors: row?.favoriteDirectors || [], favoriteAuthors: row?.favoriteAuthors || [], shareComparison: row?.shareComparison === true, shareFollowers: row?.shareFollowers === true, isCritic: row?.isCritic === true };
  }
  async save(owner: string, dto: SocialSettingsDto) {
    const ownerId = this.id(owner);
    if (dto.favoriteIds?.length) {
      const picked = await this.connection.collection('library_items').find({ _id: { $in: dto.favoriteIds.map(id => this.id(id)) }, ownerId, archived: { $ne: true } }, { projection: { catalogKey: 1 } }).toArray();
      if (picked.length !== dto.favoriteIds.length || new Set(picked.map(row => row.catalogKey || row._id.toString())).size !== dto.favoriteIds.length) throw new BadRequestException('Escolha até dez títulos seus não arquivados.');
    }
    const previous = await this.settings(owner);
    // Campos ausentes não podem virar null e apagar escolhas de outra atualização.
    const partial = Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined));
    const changes = { ...partial, ...(dto.shareFollowers === true && !previous.shareFollowers || dto.publicProfile === true && !previous.publicProfile ? { followersSince: new Date() } : {}), ...(dto.shareActivity === true && !previous.shareActivity ? { shareSince: new Date() } : {}) };
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
    const favorites = setting.favoriteIds.length ? await this.connection.collection('library_items').find({ ownerId, archived: { $ne: true }, _id: { $in: setting.favoriteIds.map(id => this.id(id)) } }).toArray() : [];
    const ordered = setting.favoriteIds.map(id => favorites.find(row => row._id.toString() === id)).filter(row => row !== undefined);
    const selected = await this.connection.collection('achievement_profiles').findOne({ ownerId });
    const award = selected?.selectedId ? await this.connection.collection('achievement_awards').findOne({ ownerId, key: selected.selectedId }) : null;
    const badge = award ? achievements.find(row => row.id === award.key) : null;
    const [followersCount,followingCount,followsYou]=await Promise.all([this.connection.collection('social_follows').countDocuments({targetId:ownerId}),this.connection.collection('social_follows').countDocuments({ownerId}),this.connection.collection('social_follows').findOne({ownerId,targetId:this.id(viewer)})]);
    return { followersCount,followingCount,followsYou:Boolean(followsYou), id: ownerId.toString(), mine: own, published: setting.publicProfile, bio: setting.bio, tastes: setting.tastes, favoriteActors: setting.favoriteActors, favoriteDirectors: setting.favoriteDirectors, favoriteAuthors: setting.favoriteAuthors, isCritic: setting.isCritic, shareComparison: setting.shareComparison, following: Boolean(await this.connection.collection('social_follows').findOne({ownerId: this.id(viewer), targetId: ownerId})), name: user.displayName || 'Player', avatar: user.avatarKey ? await this.avatars.signedUrl(user.avatarKey).catch(() => '') : user.avatar || '', ...levelFromXp(credits[0]?.xp || 0), achievement: badge ? { title: badge.title, family: badge.family } : null, totalCompleted: count[0]?.count || 0, favorites: await this.titles(viewer, ordered), completed: await this.titles(viewer, rows.slice(0, 30)), nextBefore: rows.length > 30 ? rows[29]._id.toString() : null };
  }
  async share(owner:string,id:string){
    const ownerId=this.id(owner),itemId=this.id(id);
    if(!await this.connection.collection('library_items').findOne({_id:itemId,ownerId}))throw new NotFoundException('Título não encontrado.');
    const filter={ownerId,itemId};
    try{await this.connection.collection('shared_titles').updateOne(filter,{$setOnInsert:{_id:new Types.ObjectId(),createdAt:new Date()}},{upsert:true});}catch(error){if((error as {code?:number}).code!==11000)throw error;}
    const row=await this.connection.collection('shared_titles').findOne(filter);
    return {id:row!._id.toString(),path:'/compartilhar?obra='+row!._id.toString()};
  }
  async shared(viewer:string,id:string){
    const row=await this.connection.collection('shared_titles').findOne({_id:this.id(id)});
    if(!row)throw new NotFoundException('Compartilhamento não encontrado.');
    const owner=row.ownerId.toString();
    if(owner!==viewer&&!await this.connection.collection('friendships').findOne({status:'accepted',$or:[{sender:owner,receiver:viewer},{sender:viewer,receiver:owner}]}))throw new NotFoundException('Compartilhamento não encontrado.');
    const item=await this.connection.collection('library_items').findOne({_id:row.itemId,ownerId:row.ownerId});
    if(!item)throw new NotFoundException('Título não disponível.');
    const user=await this.connection.collection('users').findOne({_id:row.ownerId},{projection:{displayName:1}});
    return {ownerName:user?.displayName||'Player',title:(await this.titles(viewer,[item]))[0]};
  }
  async favorite(owner:string,id:string,favorite:boolean){
    const ownerId=this.id(owner),itemId=this.id(id);
    id=itemId.toString();
    const item=await this.connection.collection('library_items').findOne({_id:itemId,ownerId});
    if(!item)throw new NotFoundException('Título não encontrado.');
    if(!favorite){await this.connection.collection<SocialSettings>('social_profiles').updateOne({_id:ownerId},{$pull:{favoriteIds:id}});return{favorite:false};}
    // Favoritar expressa preferência, independentemente de ter concluído o consumo.
    if(item.archived)throw new BadRequestException('Restaure o título antes de adicioná-lo aos favoritos do perfil.');
    const current=await this.settings(owner);
    if(current.favoriteIds.includes(id))return{favorite:true};
    const duplicates=typeof item.catalogKey==='string'?await this.connection.collection('library_items').find({ownerId,catalogKey:item.catalogKey,_id:{$ne:itemId}},{projection:{_id:1}}).toArray():[];
    const duplicateIds=duplicates.map(row=>row._id.toString());
    if(current.favoriteIds.some(value=>duplicateIds.includes(value)))throw new BadRequestException('Esta obra já está nos favoritos do perfil.');
    try{await this.connection.collection<SocialSettings>('social_profiles').updateOne({_id:ownerId},{$setOnInsert:{favoriteIds:[]}},{upsert:true});}catch(error){if((error as {code?:number}).code!==11000)throw error;}
    // A inclusão e o limite são atômicos; clicar em títulos diferentes em duas abas não perde favoritos.
    const result=await this.connection.collection<SocialSettings>('social_profiles').updateOne({_id:ownerId,favoriteIds:{$nin:duplicateIds},$expr:{$lt:[{$size:{$ifNull:['$favoriteIds',[]]}},10]}},{$addToSet:{favoriteIds:id}});
    if(!result.matchedCount){const latest=await this.settings(owner);if(!latest.favoriteIds.includes(id))throw new BadRequestException(latest.favoriteIds.some(value=>duplicateIds.includes(value))?'Esta obra já está nos favoritos do perfil.':'Você já tem dez favoritos. Remova um no perfil para adicionar outro.');}
    return{favorite:true};
  }
  async discover(viewer: string, query = '') {
    if (typeof query !== 'string' || query.length > 100) throw new BadRequestException('Busca inválida.');
    const settings = await this.connection.collection<SocialSettings>('social_profiles').find({ publicProfile: true }).toArray();
    const users = await this.connection.collection('users').find({ _id: { $in: settings.map(row => row._id) }, ...(query.trim() ? { displayName: { $regex: query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {}) }, { projection: { displayName: 1 } }).sort({ displayName: 1, _id: 1 }).limit(50).toArray();
    return { profiles: users.filter(user => user._id.toString() !== viewer).map(user => ({ id: user._id.toString(), name: user.displayName || 'Player', isCritic: settings.find(setting => setting._id.equals(user._id))?.isCritic === true })) };
  }
  async follow(viewer: string, target: string, following: boolean) {
    const ownerId = this.id(viewer), targetId = this.id(target);
    if (viewer === targetId.toString()) throw new BadRequestException('Não é possível seguir a si mesmo.');
    if (following && !(await this.settings(target)).publicProfile) throw new NotFoundException('Perfil privado ou não encontrado.');
    if (following) { try { await this.connection.collection('social_follows').updateOne({ ownerId, targetId }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true }); } catch(error) { if ((error as {code?:number}).code !== 11000) throw error; } }
    else await this.connection.collection('social_follows').deleteOne({ ownerId, targetId });
    return { following };
  }
  async compare(viewer: string, target: string) {
    const targetId = this.id(target), mine = await this.settings(viewer), theirs = await this.settings(target);
    if (!mine.shareComparison || !theirs.shareComparison) throw new ForbiddenException('As duas pessoas precisam habilitar a comparação de gostos.');
    if (!await this.connection.collection('friendships').findOne({ status: 'accepted', $or: [{ sender: viewer, receiver: targetId.toString() }, { sender: targetId.toString(), receiver: viewer }] })) throw new NotFoundException('Amizade aceita não encontrada.');
    const rows = await this.connection.collection('library_items').find({ ownerId: { $in: [this.id(viewer), targetId] }, status: 'completed' }, { projection: { ownerId: 1, catalogKey: 1, genres: 1, stars: 1, updatedAt: 1 } }).sort({ updatedAt: -1, _id: -1 }).toArray();
    const distinct = (id: string) => [...new Map(rows.filter(row => row.ownerId.toString() === id).reverse().map(row => [row.catalogKey, row])).values()];
    const a = distinct(viewer), b = distinct(targetId.toString()), common = a.filter(row => b.some(other => other.catalogKey === row.catalogKey));
    const rated = common.filter(row => row.stars >= 1 && row.stars <= 5 && b.some(other => other.catalogKey === row.catalogKey && other.stars >= 1 && other.stars <= 5));
    const genresA = new Set<string>(a.flatMap(row => row.genres || [])), genresB = new Set<string>(b.flatMap(row => row.genres || [])), union = new Set([...genresA, ...genresB]);
    return { commonTitles: common.length, ratedInCommon: rated.length, ratingAgreement: rated.length ? Math.round(100 * (1 - rated.reduce((sum, row) => sum + Math.abs(row.stars - b.find(other => other.catalogKey === row.catalogKey)!.stars), 0) / rated.length / 4)) : null, genreOverlap: union.size ? Math.round(100 * [...genresA].filter(genre => genresB.has(genre)).length / union.size) : null };
  }
  async feed(viewer: string, before?: string) {
    const boundary = before ? this.id(before) : null;
    const sources = await activitySources(this.connection, viewer);
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
  @Post('share/:id') @ApiOperation({summary:'Gerar link de obra para amigos',description:'Somente item próprio; link opaco não expõe ID da biblioteca. Repetir reutiliza o mesmo link. Não envia mensagens nem publica avaliações/progresso.'})
  async share(@Req()req:Request,@Param('id')id:string){return this.service.share(await this.owner(req),id);}
  @Get('shared/:id') @ApiOperation({summary:'Abrir obra compartilhada',description:'Exige dono ou amizade atualmente aceita; demais recebem 404. Só metadados públicos e nome do autor; sem notas, sessões ou progresso. Excluir item ou desfazer amizade revoga acesso.'})
  async shared(@Req()req:Request,@Param('id')id:string){return this.service.shared(await this.owner(req),id);}
  @Get('discover') @ApiQuery({ name: 'q', required: false }) @ApiOperation({ summary: 'Descobrir até 50 perfis públicos', description: 'Somente contas que publicaram perfil. Busca literal pelo nome; crítico é autodeclaração, sem verificação.' })
  async discover(@Req() request: Request, @Query('q') query?: string) { return this.service.discover(await this.owner(request), query); }
  @Patch('favorites/:id') @ApiOperation({summary:'Adicionar/remover favorito pelos detalhes do título',description:'Idempotente, preserva outros favoritos e configurações. Inclusão atômica no final da seleção, até dez; exige item próprio não arquivado. Remoção permite limpar item que mudou de status/foi arquivado. Não publica o perfil nem altera avaliação/status de consumo.'})
  async favorite(@Req()req:Request,@Param('id')id:string,@Body()dto:FavoriteDto){return this.service.favorite(await this.owner(req),id,dto.favorite);}
  @Patch('profiles/:id/follow') @ApiOperation({ summary: 'Seguir ou deixar de seguir perfil público', description: 'Idempotente, independente de amizade. Receber atividades exige a opção específica do autor para seguidores; não dá acesso a notas, listas privadas ou notificações de backlog.' })
  async follow(@Req() request: Request, @Param('id') id: string, @Body() dto: FollowDto) { return this.service.follow(await this.owner(request), id, dto.following); }
  @Get('profiles/:id/compare') @ApiOperation({ summary: 'Comparar gosto com amigo', description: 'Exige amizade aceita e shareComparison habilitado nas duas contas. Retorna somente contagens e percentuais agregados; sem notas individuais. ratingAgreement: 100*(1-média das diferenças absolutas/4), null sem notas em comum; genreOverlap é Jaccard entre gêneros consumidos.' })
  async compare(@Req() request: Request, @Param('id') id: string) { return this.service.compare(await this.owner(request), id); }
  @Get('settings') @ApiOperation({ summary: 'Consultar opções sociais privadas', description: 'Padrões: perfil privado, atividades não compartilhadas e alertas de backlog habilitados. Favoritos são privados até publicar o perfil.' })
  settings(@Req() request: Request) { return this.owner(request).then(owner => this.service.settings(owner)); }
  @Patch('settings') @ApiOperation({ summary: 'Alterar compartilhamento e Top 10', description: 'Atualização parcial persistida no MongoDB. Campos ausentes preservados. Publicar perfil e compartilhar atividades são escolhas independentes. Somente títulos próprios não arquivados podem entrar no Top 10.' })
  async save(@Req() request: Request, @Body() dto: SocialSettingsDto) { return this.service.save(await this.owner(request), dto); }
  @Get('feed') @ApiOperation({ summary: 'Atividades novas dos amigos aceitos', description: 'Até 30 eventos por página: added, started, completed. Apenas ações registradas após habilitar compartilhamento e aceitar amizade. recordedAt é data de registro, não data real de consumo/importação. Arquivamento, exclusão, desativação do compartilhamento ou remoção da amizade ocultam eventos. Não retorna notas ou avaliações individuais.' })
  @ApiQuery({ name: 'before', required: false, type: String, description: 'nextBefore da página anterior.' })
  @ApiOkResponse({ description: 'activities: id, type, recordedAt, title (key/title/kind/coverUrl/year/catalogId/viewerItemId da sessão), actor (id/name/avatar/profileAvailable). nextBefore ou null.' })
  async feed(@Req() request: Request, @Query('before') before?: string) { return this.service.feed(await this.owner(request), before); }
  @Get('profiles/:id') @ApiOperation({ summary: 'Perfil de consumo publicado para usuários do app', description: 'Exige sessão. Perfil não publicado retorna 404 para outras pessoas; o dono pode pré-visualizar. Retorna foto/nome, XP/nível, título de conquista, Top 10 ordenado e até 30 títulos concluídos não arquivados. Não inclui acervo possuído, anotações, notas individuais, sessões ou episódios. nextBefore pagina concluídos.' })
  @ApiQuery({ name: 'before', required: false, type: String })
  async profile(@Req() request: Request, @Param('id') id: string, @Query('before') before?: string) { return this.service.profile(await this.owner(request), id, before); }
}
@Module({ imports: [AuthModule, ProgressionModule], providers: [SocialService], controllers: [SocialController] })
export class SocialModule {}
