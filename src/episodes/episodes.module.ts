import { recordSocialActivity } from '../social/social-store';
import {recordPrivateActivity} from '../library/activity-history';
import { viewingProgressId, finishViewing } from '../rewatches/rewatches.module';
import { ApiProperty, ApiHeader, ApiTags, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { voteIdentity, emptyVoteIdentity } from '../library/vote-identity';
import { Body, BadRequestException, ConflictException, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, OnModuleInit, Param, Patch, Post, Req } from '@nestjs/common';
import { InjectConnection, InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { IsIn, IsBoolean, IsInt, IsOptional, Min, Max, IsString, MaxLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { CatalogModule, CatalogService } from '../catalog/catalog.module';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config';
type Episode = { number: number; name: string; airDate: string; overview: string; stillUrl?: string; runtime?: number | null };
@Schema({ collection: 'series_seasons', timestamps: true })
class Season {
  @Prop({ required: true }) catalogId!: string;
  @Prop({ required: true }) number!: number;
  @Prop({ required: true }) name!: string;
  @Prop({ default: 0 }) total!: number;
  @Prop({ default: false }) loaded!: boolean;
  @Prop({ type: [{ _id: false, number: Number, name: String, airDate: String, overview: String, stillUrl: String, runtime: Number }], default: [] }) episodes!: Episode[];
}
const SeasonSchema = SchemaFactory.createForClass(Season);
SeasonSchema.index({ catalogId: 1, number: 1 }, { unique: true });
@Schema({ collection: 'episode_progress' })
class Progress {
  @Prop({ type: Types.ObjectId, required: true }) itemId!: Types.ObjectId;
  @Prop({ required: true }) season!: number;
  @Prop({ required: true }) episode!: number;
  // O registro existe mesmo sem data conhecida; recordedAt não representa consumo.
  @Prop({ type: Date, default: null }) watchedAt!: Date | null;
  @Prop({ type: Date }) recordedAt?: Date;
  @Prop({ default: false }) watchedDateUnknown!: boolean;
  // Ausente no legado; somente marcações individuais novas podem conceder maratonas.
  @Prop({ enum: ['individual', 'bulk'] }) watchOrigin?: string;
  @Prop({ default: 0, min: 0, max: 5 }) stars!: number;
  @Prop({ default: '' }) feeling!: string;
  @Prop({ default: '', maxlength: 100 }) favoriteCharacter!: string;
  @Prop({ default: '' }) favoriteCastId!: string;
  @Prop({ default: '' }) favoriteActorId!: string;
  @Prop({ default: '' }) favoriteActorName!: string;
  @Prop({ default: '' }) favoriteActorPhoto!: string;
}
const ProgressSchema = SchemaFactory.createForClass(Progress);
ProgressSchema.index({ itemId: 1, season: 1, episode: 1 }, { unique: true });
class ImportDto { @ApiProperty({ type: Number, required: false, minimum: 0, maximum: 10000 })
  @IsOptional() @IsInt() @Min(0) @Max(10000) season?: number; @ApiProperty({ type: Boolean, required: false })
  @IsOptional() @IsBoolean() refresh?: boolean; }
class ReviewDto {
  @ApiProperty({ type: Boolean, required: false, description: 'Data de consumo desconhecida: watchedAt fica null; recordedAt guarda o registro. O episódio continua assistido e conta para totais/XP, mas não para metas diárias. Omitir preserva a data existente. Em lotes aplica apenas aos novos registros.' })
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() watchedDateUnknown?: boolean;
  @ApiProperty({ type: Number, required: false, minimum: 0, maximum: 5 })
  @IsOptional() @IsInt() @Min(0) @Max(5) stars?: number;
  @ApiProperty({ type: String, required: false, enum: ['', 'loved', 'liked', 'neutral', 'disliked', 'scared', 'happy', 'amused', 'sad', 'surprised', 'excited', 'moved', 'bored'] })
  @IsOptional() @IsIn(['', 'loved', 'liked', 'neutral', 'disliked', 'scared', 'happy', 'amused', 'sad', 'surprised', 'excited', 'moved', 'bored']) feeling?: string;
  @ApiProperty({ type: String, required: false, maxLength: 100 })
  @IsOptional() @IsString() @MaxLength(100) favoriteCharacter?: string;
  @ApiProperty({ type: String, required: false, maxLength: 500 })
  @IsOptional() @IsString() @MaxLength(500) favoriteCastId?: string;
}
class BulkWatchDto extends ReviewDto {
  @ApiProperty({ type: String, required: true, enum: ['season', 'series', 'through'] })
  @IsIn(['season', 'series', 'through']) scope!: 'season' | 'series' | 'through';
  @ApiProperty({ type: Number, required: false, minimum: 0, maximum: 10000 })
  @IsOptional() @IsInt() @Min(0) @Max(10000) season?: number;
  @ApiProperty({ type: Number, required: false, minimum: 1, maximum: 100000 })
  @IsOptional() @IsInt() @Min(1) @Max(100000) episode?: number;
}
class BulkUnwatchDto {
  @ApiProperty({ type: String, required: true, enum: ['season', 'series'] })
  @IsIn(['season', 'series']) scope!: 'season' | 'series';
  @ApiProperty({ type: Number, required: false, minimum: 0, maximum: 10000 })
  @IsOptional() @IsInt() @Min(0) @Max(10000) season?: number;
}
class WatchDto extends ReviewDto {
  @ApiProperty({ type: Number, required: true, minimum: 0, maximum: 10000 })
  @IsInt() @Min(0) @Max(10000) season!: number;
  @ApiProperty({ type: Number, required: true, minimum: 1, maximum: 100000 })
  @IsInt() @Min(1) @Max(100000) episode!: number;
  @ApiProperty({ type: Boolean, required: true })
  @IsBoolean() watched!: boolean;
}
@Injectable()
export class EpisodesService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection, @InjectModel(Season.name) private readonly seasons: Model<Season>, @InjectModel(Progress.name) private readonly progress: Model<Progress>, private readonly catalog: CatalogService) {}
  async onModuleInit() { await Promise.all([this.seasons.init(), this.progress.init()]); }
  async prepareCompletion(catalogId: string) {
    if (!/^tmdb:series:[1-9]\d{0,14}$/.test(catalogId)) return [];
    let seasons = await this.seasons.find({ catalogId }).sort({ number: 1 }).exec();
    if (!seasons.length) {
      const directory = await this.catalog.seasons(catalogId);
      for (const season of directory) await this.seasons.updateOne({ catalogId, number: season.number }, { $setOnInsert: { ...season, catalogId } }, { upsert: true });
      seasons = await this.seasons.find({ catalogId }).sort({ number: 1 }).exec();
    }
    for (const season of seasons.filter(season => season.number > 0 && !season.loaded)) {
      const episodes = await this.catalog.seasonEpisodes(catalogId, season.number);
      await this.seasons.updateOne({ _id: season._id }, { $set: { episodes, total: episodes.length, loaded: true } });
    }
    const loaded = await this.seasons.find({ catalogId, number: { $gt: 0 } }).exec();
    const today = new Date().toISOString().slice(0, 10);
    return loaded.flatMap(season => season.episodes.filter(episode => !episode.airDate || episode.airDate <= today).map(episode => ({ season: season.number, episode: episode.number })));
  }
  async markComplete(itemId: Types.ObjectId, episodes: { season: number; episode: number }[], watchedAt: Date) {
    if (episodes.length) await this.progress.bulkWrite(episodes.map(episode => ({ updateOne: { filter: { itemId, ...episode }, update: { $setOnInsert: { itemId, ...episode, watchedAt, watchOrigin: 'bulk' } }, upsert: true } })));
    await this.connection.collection('library_items').updateOne({ _id: itemId }, { $set: { episodesCompletedAt: new Date() } });
  }
  async complete(ownerId: string, id: string, expectedViewing?: string) {
    const item = await this.owned(ownerId, id, expectedViewing);
    if (item.rewatchActiveId || item.status !== 'completed' || item.episodesCompletedAt) return this.list(ownerId, id);
    if (typeof item.catalogId !== 'string') throw new BadRequestException('Série sem catálogo de episódios.');
    const episodes = await this.prepareCompletion(item.catalogId);
    await this.markComplete(item._id, episodes, item.completedAt || new Date());
    return this.list(ownerId, id);
  }
  private async owned(ownerId: string, id: string, expectedViewing?: string) {
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestException('Item inválido.');
    const item = await this.connection.collection('library_items').findOne({ _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(ownerId) });
    if (!item) throw new NotFoundException('Item não encontrado.');
    if (item.kind !== 'series') throw new BadRequestException('Este título não é uma série.');
    // Valida junto da leitura que escolhe o progresso, evitando trocar de vez entre duas consultas.
    if (expectedViewing !== undefined && (item.rewatchActiveId || '') !== expectedViewing) throw new ConflictException('A visualização mudou. Atualize o acompanhamento.');
    return item;
  }
  async list(ownerId: string, id: string) {
    const item = await this.owned(ownerId, id);
    const supported = typeof item.catalogId === 'string' && item.catalogId.startsWith('tmdb:series:');
    if (!supported) return { supported: false, seasons: [] };
    const [seasons, progress, user, participants] = await Promise.all([
      this.seasons.find({ catalogId: item.catalogId }).sort({ number: 1 }).lean().exec(),
      this.progress.find({ itemId: viewingProgressId(item) }).lean().exec(),
      this.connection.collection('users').findOne({ _id: new Types.ObjectId(ownerId) }, { projection: { language: 1 } }),
      this.connection.collection('library_items').find({ catalogId: item.catalogId, kind: 'series' }, { projection: { _id: 1 } }).toArray(),
    ]);
    const language = user?.language || 'pt-BR';
    if (language !== 'pt-BR') {
      for (const season of seasons) {
        season.name = `${language === 'en-US' ? 'Season' : 'Temporada'} ${season.number}`;
        if (!season.loaded) continue;
        const localized = await this.catalog.localizedEpisodes(item.catalogId, season.number, language);
        season.episodes = season.episodes.map(episode => { const translated = localized.find(value => value.number === episode.number); return { ...episode, name: translated?.name || episode.name, overview: translated?.overview || episode.overview }; });
      }
    }
    const votes = await this.progress.aggregate<{ _id: { season: number; episode: number; character: string }; name: string; count: number }>([
      // Usa o índice por itemId antes de agrupar votos, sem varrer avaliações de todas as séries.
      { $match: { itemId: { $in: participants.map(row => row._id) }, favoriteCharacter: { $type: 'string', $ne: '' } } },
      { $group: { _id: { season: '$season', episode: '$episode', character: { $toLower: { $trim: { input: '$favoriteCharacter' } } } }, name: { $first: '$favoriteCharacter' }, count: { $sum: 1 } } },
      { $sort: { count: -1, name: 1 } },
    ]);
    const watched = new Map(progress.map(row => [row.season + ':' + row.episode, row]));
    return { supported: true, seasons: seasons.map(season => ({ number: season.number, name: season.name, total: season.total, loaded: season.loaded, episodes: [...season.episodes].sort((a, b) => a.number - b.number).map(episode => {
      const review = watched.get(season.number + ':' + episode.number);
      return { ...episode, watched: Boolean(review), watchedDateUnknown: Boolean(review?.watchedDateUnknown), watchedAt: review?.watchedAt || null, stars: review?.stars || 0, feeling: review?.feeling || '', favoriteCharacter: review?.favoriteCharacter || '', favoriteCastId: review?.favoriteCastId || '', votes: votes.filter(vote => vote._id.season === season.number && vote._id.episode === episode.number).slice(0, 10).map(vote => ({ name: vote.name, count: vote.count })) };
    }) })) };
  }
  async import(ownerId: string, id: string, dto: ImportDto, readBack = true) {
    const item = await this.owned(ownerId, id);
    if (typeof item.catalogId !== 'string' || !item.catalogId.startsWith('tmdb:series:')) throw new BadRequestException('Importe a série pelo catálogo TMDB para acompanhar episódios.');
    this.catalog.limit(ownerId);
    if (dto.season === undefined) {
      if (dto.refresh || !(await this.seasons.exists({ catalogId: item.catalogId }))) {
        const seasons = await this.catalog.seasons(item.catalogId);
        for (const season of seasons) {
          try { await this.seasons.updateOne({ catalogId: item.catalogId, number: season.number }, { $set: { ...season, catalogId: item.catalogId } }, { upsert: true }); }
          catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
        }
      }
    } else {
      const season = await this.seasons.findOne({ catalogId: item.catalogId, number: dto.season }).exec();
      if (!season) throw new NotFoundException('Temporada não encontrada.');
      if (dto.refresh || !season.loaded) {
        const episodes = await this.catalog.seasonEpisodes(item.catalogId, dto.season);
        await this.seasons.updateOne({ _id: season._id }, { $set: { episodes, total: episodes.length, loaded: true } });
      }
    }
    // Lotes só precisam carregar os metadados: a resposta completa é montada uma vez ao final.
    if (readBack) return this.list(ownerId, id);
  }
  async watchMany(ownerId: string, id: string, dto: BulkWatchDto, expectedViewing?: string) {
    const item = await this.owned(ownerId, id, expectedViewing);
    if (typeof item.catalogId !== 'string' || !item.catalogId.startsWith('tmdb:series:')) throw new BadRequestException('Esta série precisa estar vinculada ao TMDB.');
    if (dto.scope !== 'series' && dto.season == null) throw new BadRequestException('Informe a temporada.');
    if (dto.scope === 'through' && dto.episode == null) throw new BadRequestException('Informe o episódio.');
    if (!(await this.seasons.exists({ catalogId: item.catalogId }))) await this.import(ownerId, id, {}, false);
    const directory = await this.seasons.find({ catalogId: item.catalogId }).sort({ number: 1 }).exec();
    if (dto.scope !== 'series' && !directory.some(season => season.number === dto.season)) throw new NotFoundException('Temporada não encontrada.');
    const included = directory.filter(season => dto.scope === 'series' ? season.number > 0 : dto.scope === 'season' ? season.number === dto.season : dto.season === 0 ? season.number === 0 : season.number > 0 && season.number <= dto.season!);
    for (const season of included) if (!season.loaded) await this.import(ownerId, id, { season: season.number }, false);
    const seasons = await this.seasons.find({ catalogId: item.catalogId, number: { $in: included.map(season => season.number) } }).exec();
    const today = new Date().toISOString().slice(0, 10);
    if (dto.scope === 'through') {
      const target = seasons.find(season => season.number === dto.season)?.episodes.find(episode => episode.number === dto.episode);
      if (!target) throw new NotFoundException('Episódio não encontrado.');
      if (target.airDate && target.airDate > today) throw new BadRequestException('Este episódio ainda não estreou.');
    }
    const episodes = seasons.flatMap(season => season.episodes.filter(episode => (!episode.airDate || episode.airDate <= today) && (dto.scope !== 'through' || season.number < dto.season! || episode.number <= dto.episode!)).map(episode => ({ season: season.number, episode: episode.number })));
    if (!episodes.length) throw new BadRequestException('Nenhum episódio já lançado nesta seleção.');
    const now = new Date();
    const identity = dto.scope === 'season' && dto.favoriteCharacter?.trim() ? await voteIdentity(this.connection, item.catalogId, dto.favoriteCharacter.trim(), dto.favoriteCastId) : {};
    await this.progress.bulkWrite(episodes.map(episode => ({ updateOne: { filter: { itemId: viewingProgressId(item), ...episode }, update: { $setOnInsert: { itemId: viewingProgressId(item), ...episode, watchedAt: dto.watchedDateUnknown ? null : now, recordedAt: now, watchedDateUnknown: dto.watchedDateUnknown || false, watchOrigin: 'bulk' }, ...(dto.scope === 'season' && dto.favoriteCharacter?.trim() ? { $set: { favoriteCharacter: dto.favoriteCharacter.trim(), ...identity } } : {}) }, upsert: true } })));
    if (dto.scope === 'series' && item.rewatchActiveId) await finishViewing(this.connection, item, dto.watchedDateUnknown);
    else if (dto.scope === 'series') {
      const changed = await this.connection.collection('library_items').updateOne({ _id: item._id, status: item.status }, { $set: { status: 'completed', watchedDateUnknown: item.status === 'completed' ? Boolean(item.watchedDateUnknown) : Boolean(dto.watchedDateUnknown), completedOn: (item.status === 'completed' ? item.watchedDateUnknown : dto.watchedDateUnknown) ? null : item.completedOn || today, completedAt: item.completedAt || now, episodesCompletedAt: now, updatedAt: now } });
      if (changed.modifiedCount && item.status !== 'completed') await recordSocialActivity(this.connection, item._id, 'completed');
    }
    else if (!item.rewatchActiveId) {
      const changed = await this.connection.collection('library_items').updateOne({ _id: item._id, status: 'planned' }, { $set: { status: 'active', updatedAt: new Date() } });
      if (changed.modifiedCount) await recordSocialActivity(this.connection, item._id, 'started');
    }
    await recordPrivateActivity(this.connection,item as any,dto.scope==='season'?`season-watched:S${dto.season}`:'episodes-watched');
    if (dto.scope === 'through') return this.watch(ownerId, id, { season: dto.season!, episode: dto.episode!, watched: true, stars: dto.stars, feeling: dto.feeling, favoriteCharacter: dto.favoriteCharacter, favoriteCastId: dto.favoriteCastId }, item.rewatchActiveId || '');
    return this.list(ownerId, id);
  }
  async unwatchMany(ownerId: string, id: string, dto: BulkUnwatchDto, expectedViewing?: string) {
    const item = await this.owned(ownerId, id, expectedViewing);
    if (dto.scope === 'season' && dto.season === undefined) throw new BadRequestException('Informe a temporada.');
    if (dto.scope === 'season' && !await this.seasons.exists({ catalogId: item.catalogId, number: dto.season })) throw new NotFoundException('Temporada não encontrada.');
    await this.progress.deleteMany({ itemId: viewingProgressId(item), ...(dto.scope === 'season' ? { season: dto.season } : {}) });
    const remaining = await this.progress.exists({ itemId: viewingProgressId(item) });
    if (!item.rewatchActiveId) await this.connection.collection('library_items').updateOne({ _id: item._id, ownerId: new Types.ObjectId(ownerId) }, { $set: { status: remaining ? 'active' : 'planned', completedOn: null, completedAt: null, stars: 0, feeling: '', favoriteCharacter: '', ...emptyVoteIdentity }, $unset: { episodesCompletedAt: '' } });
    await recordPrivateActivity(this.connection,item as any,'episodes-unwatched');
    return this.list(ownerId, id);
  }
  async watch(ownerId: string, id: string, dto: WatchDto, expectedViewing?: string) {
    const item = await this.owned(ownerId, id, expectedViewing);
    const season = await this.seasons.findOne({ catalogId: item.catalogId, number: dto.season, loaded: true }).exec();
    const episode = season?.episodes.find(episode => episode.number === dto.episode);
    if (!episode) throw new NotFoundException('Episódio não encontrado.');
    if (dto.watched && episode.airDate && episode.airDate > new Date().toISOString().slice(0, 10)) throw new BadRequestException('Este episódio ainda não estreou.');
    const filter = { itemId: viewingProgressId(item), season: dto.season, episode: dto.episode };
    if (dto.watched) {
      const previous = await this.progress.findOne(filter).lean().exec();
      const identity = dto.favoriteCharacter === undefined ? {} : previous?.favoriteActorId && dto.favoriteCharacter.trim() === previous.favoriteCharacter && (!dto.favoriteCastId || dto.favoriteCastId === previous.favoriteCastId)
        ? { favoriteCastId: previous.favoriteCastId, favoriteActorId: previous.favoriteActorId, favoriteActorName: previous.favoriteActorName, favoriteActorPhoto: previous.favoriteActorPhoto }
        : await voteIdentity(this.connection, item.catalogId, dto.favoriteCharacter.trim(), dto.favoriteCastId, dto.season, dto.episode);
      try { await this.progress.updateOne(filter, { $setOnInsert: { ...filter, watchedAt: dto.watchedDateUnknown ? null : new Date(), recordedAt: new Date(), watchedDateUnknown: dto.watchedDateUnknown || false, watchOrigin: 'individual' } }, { upsert: true }); }
      catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
      // Reavaliar sem escolha explícita preserva a data; desconhecida nunca recebe hoje por fallback.
      const review = { ...identity, ...(dto.watchedDateUnknown !== undefined ? { watchedDateUnknown: dto.watchedDateUnknown, watchedAt: dto.watchedDateUnknown ? null : previous?.watchedAt || new Date() } : {}), ...(dto.stars !== undefined ? { stars: dto.stars } : {}), ...(dto.feeling !== undefined ? { feeling: dto.feeling } : {}), ...(dto.favoriteCharacter !== undefined ? { favoriteCharacter: dto.favoriteCharacter.trim() } : {}) };
      if (Object.keys(review).length) await this.progress.updateOne(filter, { $set: review }, { runValidators: true });
      if (!item.rewatchActiveId) {
      const changed = await this.connection.collection('library_items').updateOne({ _id: item._id, status: 'planned' }, { $set: { status: 'active', updatedAt: new Date() } });
      if (changed.modifiedCount) await recordSocialActivity(this.connection, item._id, 'started');
    }
    } else {
      await this.progress.deleteOne(filter);
      if (!item.rewatchActiveId) await this.connection.collection('library_items').updateOne({ _id: item._id, status: 'completed' }, { $set: { status: 'active', completedOn: null, completedAt: null }, $unset: { episodesCompletedAt: '' } });
    }
    await recordPrivateActivity(this.connection,item as any,'episode-updated:S'+dto.season+'E'+dto.episode);
    return this.list(ownerId, id);
  }
}
@ApiTags('library/:id/episodes')
@ApiCookieAuth('session')
@ApiHeader({ name: 'X-Viewing-Id', required: false, description: 'ID da repetição ativa, obrigatório ao alterá-la. Ausente representa a primeira visualização; conflito entre abas retorna 409.' })
@Controller('library/:id/episodes')
class EpisodesController {
  constructor(private readonly service: EpisodesService, private readonly auth: AuthService) {}
  private async owner(request: Request) {
    if (request.method !== 'GET' && request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem da requisição não permitida.');
    const raw: unknown = request.cookies?.[getConfig().cookieName];
    const owner = (await this.auth.me(typeof raw === 'string' ? raw : undefined)).id;
    return owner;
  }
  @Post('unwatch-many') async unwatchMany(@Req() request: Request, @Param('id') id: string, @Body() dto: BulkUnwatchDto) { return this.service.unwatchMany(await this.owner(request), id, dto, request.get('X-Viewing-Id') || ''); }
  @ApiOperation({ summary: 'Marcar episódios em lote', description: 'watchedDateUnknown=true registra novos episódios sem data de consumo; registros existentes preservam sua data. Contam para acompanhamento, tempo e XP, sem metas diárias.' })
  @Post('watch-many') async watchMany(@Req() request: Request, @Param('id') id: string, @Body() dto: BulkWatchDto) { return this.service.watchMany(await this.owner(request), id, dto, request.get('X-Viewing-Id') || ''); }
  @Post('complete') async complete(@Req() request: Request, @Param('id') id: string) { return this.service.complete(await this.owner(request), id, request.get('X-Viewing-Id') || ''); }
  @Get() async list(@Req() request: Request, @Param('id') id: string) { return this.service.list(await this.owner(request), id); }
  @Post('import') async import(@Req() request: Request, @Param('id') id: string, @Body() dto: ImportDto) { return this.service.import(await this.owner(request), id, dto); }
  @Patch()
  @ApiOperation({ summary: 'Marcar/desmarcar ou avaliar um episódio', description: 'Uma marcação nova recebe origem individual. Por padrão usa a data do servidor; watchedDateUnknown=true mantém watchedAt=null e recordedAt separado, sem contar para maratonas. Reavaliar/remarcar um episódio existente preserva sua origem/data; registros legados ou feitos em lote não viram marcações individuais.' })
  async watch(@Req() request: Request, @Param('id') id: string, @Body() dto: WatchDto) { return this.service.watch(await this.owner(request), id, dto, request.get('X-Viewing-Id') || ''); }
}
@Module({ imports: [AuthModule, CatalogModule, MongooseModule.forFeature([{ name: Season.name, schema: SeasonSchema }, { name: Progress.name, schema: ProgressSchema }])], providers: [EpisodesService], exports: [EpisodesService], controllers: [EpisodesController] })
export class EpisodesModule {}
