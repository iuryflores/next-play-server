import { recordSocialActivity } from '../social/social-store';
import {recordPrivateActivity} from './activity-history';
import { CommunityService } from '../community/community.service';
import { RewatchModule, RewatchService, RewatchDto, viewingProgressId, type Viewing } from '../rewatches/rewatches.module';
import { gameStatusEvent, type GameStatusEvent } from './game-status-event';
import { ApiProperty, ApiTags, ApiCookieAuth, ApiOperation, ApiQuery, ApiOkResponse, ApiResponse } from '@nestjs/swagger';
import { voteIdentity, emptyVoteIdentity } from './vote-identity';
import { snapshot } from './ranking-snapshot';
import { compareRankingVisit } from './ranking-visits';



import { actorVotes, type CastCache } from './actor-votes';
import { EpisodesModule, EpisodesService } from '../episodes/episodes.module';
import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, Query, Patch, Post, Req, ForbiddenException, BadRequestException, ConflictException, OnModuleInit } from '@nestjs/common';
import { CatalogModule, CatalogService, GameEstimateDto } from '../catalog/catalog.module';
import { BooksModule, BooksService } from '../books/books.module';
import { InjectConnection, InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Connection, Model, Schema as MongoSchema, Types, HydratedDocument } from 'mongoose';
import { createHash } from 'node:crypto';
import { Transform } from 'class-transformer';
import { ValidateIf, IsUUID, IsBoolean, IsInt, Min, Max, Matches, IsArray, ArrayMaxSize, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config';
import { sessionMinutes, type GameSession } from '../game-sessions/game-sessions.module';

const kinds = ['movie', 'series', 'game', 'book'];
const statuses = ['planned', 'active', 'completed'];
@Schema({ timestamps: true, collection: 'library_items' })
class LibraryItem {
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, index: true }) ownerId!: Types.ObjectId;
  @Prop({ required: true, maxlength: 200 }) title!: string;
  @Prop({ maxlength: 200 }) originalTitle?: string;
  @Prop({ required: true, enum: kinds }) kind!: string;
  @Prop({ required: true, enum: statuses }) status!: string;
  @Prop({ enum: ['none', 'high', 'medium', 'low'], default: 'none' }) priority!: string;
  @Prop({ default: false }) archived!: boolean;
  @Prop({ default: false }) rewatchWanted!: boolean;
  @Prop({ type: String, default: null }) rewatchActiveId?: string | null;
  @Prop({ type: [Object], default: undefined }) rewatches?: Viewing[];
  @Prop({ default: '', maxlength: 1000 }) notes!: string;
  @Prop({ default: false }) watchedDateUnknown!: boolean;
  @Prop({ type: String }) completedOn?: string | null;
  @Prop({ type: Date }) completedAt?: Date | null;
  @Prop({ type: Date }) episodesCompletedAt?: Date;
  @Prop({ default: 0, min: 0, max: 5 }) stars!: number;
  @Prop({ default: '' }) feeling!: string;
  @Prop({ default: '', maxlength: 100 }) favoriteCharacter!: string;
  @Prop({ default: '' }) favoriteCastId!: string;
  @Prop({ default: '' }) favoriteActorId!: string;
  @Prop({ default: '' }) favoriteActorName!: string;
  @Prop({ default: '' }) favoriteActorPhoto!: string;
  @Prop({ type: [String], default: [] }) genres!: string[];
  @Prop({ default: '', maxlength: 60 }) platform!: string;
  @Prop({ default: 0, min: 0, max: 6000000 }) playtimeMinutes!: number;
  @Prop({ type: [Object], default: undefined }) gameStatusHistory?: GameStatusEvent[];
  @Prop({ type: [Object], default: undefined }) gameSessions?: GameSession[];
  @Prop({ type: Number }) gameSessionRevision?: number;
  @Prop({ type: String, default: null }) lastPlayedOn?: string | null;
  @Prop() steamImportAppId?: string;
  @Prop() catalogKey?: string;
  @Prop() parentGameCatalogId?: string;
  @Prop() catalogId?: string;
  @Prop() coverUrl?: string;
  @Prop() year?: string;
  @Prop({ type: [{ _id: false, id: Number, name: String, logoUrl: String }], default: undefined }) productionCompanies?: { id: number; name: string; logoUrl?: string | null }[];
  @Prop({ type: Number }) runtime?: number | null;
  @Prop() releaseDate?: string;
  @Prop() unreleased?: boolean;
  @Prop() overview?: string;
  @Prop() sourceUrl?: string;
  @Prop({ type: [String], default: undefined }) authors?: string[];
  @Prop() publisher?: string;
  @Prop() isbn?: string;
  @Prop() language?: string;
  @Prop({ default: 0 }) bookMetadataVersion!: number;
}
const ItemSchema = SchemaFactory.createForClass(LibraryItem);
ItemSchema.index({ ownerId: 1, updatedAt: -1 });
ItemSchema.index({ ownerId: 1, catalogKey: 1 });
// A leitura de votos de episódios localiza primeiro os acompanhamentos da mesma série.
ItemSchema.index({ catalogId: 1, kind: 1 });
ItemSchema.index({ ownerId: 1, catalogId: 1 }, { unique: true, partialFilterExpression: { catalogId: { $type: 'string' } } });
@Schema({ timestamps: true, collection: 'catalog_titles' })
class CatalogEntry {
  @Prop({ required: true, unique: true }) key!: string;
  @Prop({ required: true }) title!: string;
  @Prop({ maxlength: 200 }) originalTitle?: string;
  @Prop({ required: true, enum: kinds }) kind!: string;
  @Prop({ type: [String], default: [] }) genres!: string[];
  @Prop() parentGameCatalogId?: string;
  @Prop() catalogId?: string;
  @Prop() coverUrl?: string;
  @Prop() year?: string;
  @Prop({ type: [{ _id: false, id: Number, name: String, logoUrl: String }], default: undefined }) productionCompanies?: { id: number; name: string; logoUrl?: string | null }[];
  @Prop({ type: Number }) runtime?: number | null;
  @Prop() releaseDate?: string;
  @Prop() unreleased?: boolean;
  @Prop() overview?: string;
  @Prop() sourceUrl?: string;
  @Prop({ type: [String], default: undefined }) authors?: string[];
  @Prop() publisher?: string;
  @Prop() isbn?: string;
  @Prop() language?: string;
  @Prop({ default: 0 }) bookMetadataVersion!: number;
}
const CatalogSchema = SchemaFactory.createForClass(CatalogEntry);
CatalogSchema.index({ kind: 1, genres: 1 });
@Schema({ timestamps: true, collection: 'title_comments' })
class TitleComment {
  @Prop({ required: true, index: true }) catalogKey!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true }) ownerId!: Types.ObjectId;
  @Prop({ required: true, maxlength: 2000 }) text!: string;
  createdAt!: Date;
}
const CommentSchema = SchemaFactory.createForClass(TitleComment);
CommentSchema.index({ catalogKey: 1, _id: -1 });
class CommentDto {
  @ApiProperty({ required:false, type:Boolean, description:'Protegido como possível spoiler por padrão. false permite texto comum, salvo termos de risco identificados por heurística. Não garante detecção semântica completa.' })
  @ValidateIf((_o,value)=>value!==undefined) @IsBoolean() spoiler?:boolean;
  @ApiProperty({ type: String, required: false, format: 'uuid', description: 'Chave por autor para reenviar a mesma publicação sem duplicá-la. Mesma chave com outro texto/título/comentário principal retorna 409.' })
  @ValidateIf((_o, value) => value !== undefined) @IsUUID() clientRequestId?: string;
  @ApiProperty({ type: String, required: true, minLength: 1, maxLength: 2000 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
}
class CommentLikeDto {
  @ApiProperty({ type: Boolean, description: 'Estado desejado da curtida. Reenvios não duplicam contagem; false remove somente a própria curtida.' })
  @IsBoolean() liked!: boolean;
}
class ArchiveDto { @ApiProperty({ type: Boolean, required: true })
  @IsBoolean() archived!: boolean; }
class PriorityDto {
  @ApiProperty({ enum: ['none', 'high', 'medium', 'low'], description: 'Prioridade privada do backlog; none remove a prioridade. Não altera status ou progresso.' })
  @IsIn(['none', 'high', 'medium', 'low']) priority!: string;
}
class GameTimeDto {
  @ApiProperty({ required: false, minimum: 0, maximum: 6000000, description: 'Total visto pelo cliente. Quando informado, rejeita alterações concorrentes com 409.' })
  @IsOptional() @IsInt() @Min(0) @Max(6000000) expectedTotal?: number;
  @ApiProperty({ enum: ['add', 'total'], description: 'add soma minutos ao tempo salvo; total substitui o total acumulado.' })
  @IsIn(['add', 'total']) mode!: 'add' | 'total';
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 6000000, description: 'Minutos inteiros. add exige pelo menos 1; total aceita zero. Total acumulado limitado a 6.000.000 minutos.' })
  @IsInt() @Min(0) @Max(6000000) minutes!: number;
}
class GameStatusHistoryQuery {
  @ApiProperty({ type: String, format: 'uuid', required: false, description: 'Cursor retornado em nextBefore. Até 30 eventos por página, mais recentes primeiro.' })
  @IsOptional() @IsUUID() before?: string;
}
class ItemDto {
  @ApiProperty({ type: String, required: false, description: 'ID da repetição ativa ou original. Obrigatório para editar uma repetição em andamento; uma aba com visualização diferente recebe 409.' })
  @ValidateIf((_object, value) => value !== undefined) @Matches(/^(original|[a-f0-9]{24})$/i) viewingId?: string;
  @ApiProperty({ required: false, enum: ['none', 'high', 'medium', 'low'], description: 'Prioridade do backlog. Ausente preserva na edição; no cadastro usa none.' })
  @ValidateIf((_object, value) => value !== undefined) @IsIn(['none', 'high', 'medium', 'low']) priority?: string;
  @ApiProperty({ type: String, required: true, minLength: 1, maxLength: 200 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @ApiProperty({ type: String, required: true, enum: kinds })
  @IsIn(kinds) kind!: string;
  @ApiProperty({ type: String, required: true, enum: statuses, description: 'Para livros: planned = Quero ler, active = Lendo, completed = Lido. Posse fica separada em collector_copies.' })
  @IsIn(statuses) status!: string;
  @ApiProperty({ type: String, required: false, maxLength: 1000 })
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [String], required: false, maxLength: 60, maxItems: 8 })
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(60, { each: true }) genres?: string[];
  @ApiProperty({ type: String, required: false, maxLength: 60 })
  @IsOptional() @IsString() @MaxLength(60) platform?: string;
  @ApiProperty({ type: 'integer', required: false, minimum: 0, maximum: 6000000, description: 'Tempo total jogado em minutos, exclusivo de jogos. Ausente preserva o valor na edição; zero limpa. Não entra no ranking de séries.' })
  @IsOptional() @IsInt() @Min(0) @Max(6000000) playtimeMinutes?: number;
  @ApiProperty({ type: Boolean, required: false, description: 'Somente filmes concluídos: data de consumo desconhecida. Mantém completedAt como registro, sem presumir consumo hoje. Incompatível com completedOn.' })
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() watchedDateUnknown?: boolean;
  @ApiProperty({ type: String, required: false, format: 'date', description: 'Data real de conclusão. Em filmes, omitir quando watchedDateUnknown=true; informar uma data remove a indicação de desconhecida.' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) completedOn?: string;
  @ApiProperty({ type: Number, required: false, minimum: 0, maximum: 5 })
  @IsOptional() @IsInt() @Min(0) @Max(5) stars?: number;
  @ApiProperty({ type: String, required: false, enum: ['', 'loved', 'liked', 'neutral', 'disliked', 'scared', 'happy', 'amused', 'sad', 'surprised', 'excited', 'moved', 'bored'] })
  @IsOptional() @IsIn(['', 'loved', 'liked', 'neutral', 'disliked', 'scared', 'happy', 'amused', 'sad', 'surprised', 'excited', 'moved', 'bored']) feeling?: string;
  @ApiProperty({ type: String, required: false, maxLength: 100 })
  @IsOptional() @IsString() @MaxLength(100) favoriteCharacter?: string;
  @ApiProperty({ type: String, required: false, maxLength: 500 })
  @IsOptional() @IsString() @MaxLength(500) favoriteCastId?: string;
  @ApiProperty({ type: String, required: false, maxLength: 117, description: 'Referência opcional. Livros usam googlebooks:book:<volumeId>; sem referência, cadastro manual. Metadados são resolvidos no servidor.' })
  @IsOptional() @IsString() @MaxLength(117) catalogId?: string;
}
@Injectable()
export class LibraryService implements OnModuleInit {
  constructor(@InjectModel(LibraryItem.name) private readonly items: Model<LibraryItem>, private readonly catalog: CatalogService, @InjectModel(CatalogEntry.name) private readonly titles: Model<CatalogEntry>, @InjectModel(TitleComment.name) private readonly comments: Model<TitleComment>, @InjectConnection() private readonly connection: Connection, private readonly episodes: EpisodesService, private readonly books: BooksService, private readonly rewatches: RewatchService, private readonly communityService: CommunityService) {}
  async onModuleInit() {
    await Promise.all([this.items.init(), this.titles.init(), this.comments.init()]);
    // Backfill metadata already saved locally; never call providers at startup.
    for await (const item of this.items.find({ catalogKey: { $exists: false } }).cursor()) {
      const key = await this.remember(item);
      await this.items.updateOne({ _id: item._id, catalogKey: { $exists: false } }, { $set: { catalogKey: key } });
    }
  }
  private async completion(dto: ItemDto, previous?: LibraryItem, catalogId?: string) {
    if (dto.status !== 'completed') return { watchedDateUnknown: false, ...emptyVoteIdentity, completedOn: null, completedAt: null, stars: 0, feeling: '', favoriteCharacter: '' };
    const now = new Date();
    // A data de cadastro continua em completedAt; ausência de data de consumo é explícita.
    if (dto.watchedDateUnknown === true && dto.completedOn) throw new BadRequestException('Escolha uma data ou Não sei a data.');
    if (dto.watchedDateUnknown === true && (previous?.kind || dto.kind) !== 'movie') throw new BadRequestException('Data desconhecida disponível somente para filmes neste formulário.');
    const watchedDateUnknown = dto.watchedDateUnknown ?? (dto.completedOn ? false : previous?.watchedDateUnknown || false);
    const completedOn = watchedDateUnknown ? null : dto.completedOn || previous?.completedOn || now.toISOString().slice(0, 10);
    const date = new Date(completedOn + 'T00:00:00Z');
    if (!watchedDateUnknown && (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== completedOn || completedOn > new Date(now.getTime() + 14 * 3600000).toISOString().slice(0, 10))) throw new BadRequestException('Informe uma data de conclusão válida, sem ser no futuro.');
    const name = (dto.favoriteCharacter ?? previous?.favoriteCharacter ?? '').trim();
    const identity = (!dto.favoriteCastId || dto.favoriteCastId === previous?.favoriteCastId) && name === previous?.favoriteCharacter && previous?.favoriteActorId
      ? { favoriteCastId: previous.favoriteCastId, favoriteActorId: previous.favoriteActorId, favoriteActorName: previous.favoriteActorName, favoriteActorPhoto: previous.favoriteActorPhoto }
      : await voteIdentity(this.connection, catalogId || previous?.catalogId, name, dto.favoriteCastId);
    return { ...identity, watchedDateUnknown, completedOn, completedAt: previous?.completedAt || now, stars: dto.stars ?? previous?.stars ?? 0, feeling: dto.feeling ?? previous?.feeling ?? '', favoriteCharacter: (dto.favoriteCharacter ?? previous?.favoriteCharacter ?? '').trim() };
  }
  private async owned(ownerId: string, id: string) {
    const item = await this.items.findOne({ _id: this.id(id), ownerId }).exec();
    if (!item) throw new NotFoundException('Item não encontrado.');
    return item;
  }
  async community(ownerId: string, id: string, before?: string) {
    const item = await this.owned(ownerId, id);
    const page = await this.communityService.list(ownerId, id, before);
    const votes = await this.items.find({ catalogKey: item.catalogKey, status: 'completed', favoriteCharacter: { $nin: ['', null] } }).select('ownerId favoriteCharacter').lean().exec();
    const tallies = new Map<string, { name: string; owners: Set<string> }>();
    for (const vote of votes) {
      const name = vote.favoriteCharacter?.trim(); if (!name) continue;
      const key = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
      const tally = tallies.get(key) || { name, owners: new Set<string>() }; tally.owners.add(vote.ownerId.toString()); tallies.set(key, tally);
    }
    return { ...page, votes: [...tallies.values()].map(tally => ({ name: tally.name, count: tally.owners.size })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 10) };
  }
  async cast(ownerId: string, id: string, language: string, season?: number, episode?: number) {
    const item = await this.owned(ownerId, id);
    this.catalog.limit(ownerId);
    return { cast: await this.catalog.cast(item.catalogId, language, season, episode) };
  }
  async gameAddons(ownerId: string, id: string, language: string, page: number) {
    const item = await this.owned(ownerId, id);
    if (item.kind !== 'game') throw new BadRequestException('Conteúdos adicionais disponíveis somente para jogos.');
    this.catalog.limit(ownerId);
    const result = await this.catalog.gameAddons(item.catalogId, language, page);
    const directory = item.catalogId ? await this.connection.collection<{ _id: string; refs: { id: number; contentType: string }[] }>('catalog_game_addons').findOne({ _id: item.catalogId }) : null;
    const dependent = (directory?.refs || []).filter(ref => ref.contentType !== 'standalone-expansion').map(ref => `igdb:game:${ref.id}`);
    const tracked = dependent.length ? await this.items.find({ ownerId, kind: 'game', catalogId: { $in: dependent } }).select('-gameSessions -gameStatusHistory').exec() : [];
    // A resposta privada complementa o cache público; só devolve partes pertencentes à sessão.
    return { ...result, trackedParts: tracked.map(part => ({ ...this.publicItem(part), parentGameCatalogId: item.catalogId })) };
  }
  async gameEstimate(ownerId: string, id: string) {
    const item = await this.owned(ownerId, id);
    if (item.kind !== 'game') throw new BadRequestException('A estimativa está disponível somente para jogos.');
    this.catalog.limit(ownerId);
    return this.catalog.gameEstimate(item.catalogId);
  }
  async directors(ownerId: string, id: string) {
    const item = await this.owned(ownerId, id);
    if (item.kind !== 'movie') return { directors: [], supported: false };
    this.catalog.limit(ownerId);
    return this.catalog.directors(item.catalogId);
  }
  async trailer(ownerId: string, id: string, language: string) {
    const item = await this.owned(ownerId, id);
    this.catalog.limit(ownerId);
    return { trailer: await this.catalog.trailer(item.catalogId, language) };
  }
  async rankingVisit(ownerId: string, visitId?: string) {
    const data = await this.stats(ownerId);
    const items = await this.list(ownerId);
    return { ...data, ...await compareRankingVisit(this.connection, ownerId, 'stats', visitId, snapshot(data, items)) };
  }
  async comment(ownerId: string, id: string, dto: CommentDto) { await this.communityService.create(ownerId, id, dto); }
  async deleteComment(ownerId: string, id: string, commentId: string) { await this.communityService.remove(ownerId, id, commentId); }
  async commentThread(ownerId: string, id: string, commentId: string, after?: string) { return this.communityService.thread(ownerId, id, commentId, after); }
  async reply(ownerId: string, id: string, commentId: string, dto: CommentDto) { return { comment: await this.communityService.create(ownerId, id, dto, commentId) }; }
  async commentLike(ownerId: string, id: string, commentId: string, liked: boolean) { return this.communityService.like(ownerId, id, commentId, liked); }
  private metadata(item: Partial<CatalogEntry>) {
    return { title: item.title, originalTitle: item.originalTitle, kind: item.kind, genres: item.genres || [], parentGameCatalogId: item.parentGameCatalogId, catalogId: item.catalogId, coverUrl: item.coverUrl, year: item.year, runtime: item.runtime, productionCompanies: item.productionCompanies, releaseDate: item.releaseDate, unreleased: item.unreleased, overview: item.overview, sourceUrl: item.sourceUrl, ...(item.kind === 'book' ? { authors: item.authors || [], publisher: item.publisher || '', isbn: item.isbn || '', language: item.language || '', bookMetadataVersion: item.bookMetadataVersion || 0 } : {}) };
  }
  private async remember(item: Partial<CatalogEntry>) {
    const key = item.catalogId || 'local:' + createHash('sha256').update(item.kind + ':' + item.title!.trim().toLocaleLowerCase('pt-BR')).digest('hex').slice(0, 40);
    try { await this.titles.updateOne({ key }, { $setOnInsert: { ...this.metadata(item), key } }, { upsert: true }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    return key;
  }
  async explore(ownerId: string, language = 'pt-BR', page = 1, selectedKind?: string) {
    if (!Number.isInteger(page) || page < 1 || page > (selectedKind === 'book' || !selectedKind ? 50 : 500) || selectedKind && !kinds.includes(selectedKind)) throw new BadRequestException('Página ou categoria inválida.');
    const owned = await this.items.find({ ownerId }, { gameSessions: 0, gameStatusHistory: 0 }).lean().exec();
    const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
    // Catálogos independentes são consultados em paralelo para um provedor lento
    // não somar seu tempo de espera ao de todas as outras seções.
    const sections = await Promise.all(kinds.filter(kind => !selectedKind || kind === selectedKind).map(async kind => {
      if (kind === 'book') {
        // Explorar recomenda leitura, sem usar exemplares possuídos como histórico
        // de consumo. O serviço preserva a prioridade título > autor > editora.
        try {
          this.books.limit(ownerId);
          const suggestions = await this.books.suggestions(page, ownerId, 'reading', language);
          return { kind, source: 'googlebooks', personalized: suggestions.personalized === true, genres: [], nextPage: suggestions.nextPage,
            results: suggestions.results.map(item => ({ ...item, matches: [] as string[] })) };
        } catch {
          // A indisponibilidade de um catálogo não derruba as demais categorias.
          return { kind, source: 'googlebooks', personalized: false, genres: [], nextPage: null, results: [], unavailable: true };
        }
      }
      const weights = new Map<string, number>();
      for (const item of owned.filter(item => item.kind === kind)) {
        for (const genre of new Set((item.genres || []).map(normalize).filter(Boolean))) weights.set(genre, (weights.get(genre) || 0) + 1);
      }
      const ranked = [...weights].sort((a, b) => b[1] - a[1]);
      const ownedNames = new Set(owned.filter(item => item.kind === kind && !item.catalogId).map(item => normalize(item.title)));
      const ownedKeys = owned.flatMap(item => [item.catalogKey, item.catalogId].filter((key): key is string => typeof key === 'string'));
      if (kind === 'movie' || kind === 'series') {
        try {
          const suggestions = await this.catalog.suggestions(kind, ownerId, language, page);
          const results = suggestions.results.map(item => {
            const matches = (item.genres || []).filter(genre => weights.has(normalize(genre)));
            return { ...item, matches, relevance: matches.reduce((sum, genre) => sum + (weights.get(normalize(genre)) || 0), 0) };
          }).sort((a, b) => b.relevance - a.relevance);
          return { kind, nextPage: suggestions.nextPage, totalPages: suggestions.totalPages, source: 'tmdb', personalized: weights.size > 0, genres: ranked.slice(0, 3).map(([genre]) => genre), results };
        } catch { return { kind, source: 'tmdb', personalized: weights.size > 0, genres: ranked.slice(0, 3).map(([genre]) => genre), results: [], unavailable: true }; }
      }
      const candidates = await this.titles.find({ kind, key: { $nin: ownedKeys } }).lean().exec();
      const results = candidates.filter(item => !ownedNames.has(normalize(item.title))).map(item => {
        const matches = [...new Map((item.genres || []).filter(genre => weights.has(normalize(genre))).map(genre => [normalize(genre), genre])).values()];
        return { ...this.metadata(item), catalogId: item.key, inCollection: ownedNames.has(normalize(item.title)), matches, score: matches.reduce((sum, genre) => sum + (weights.get(normalize(genre)) || 0), 0) };
      }).filter(item => !weights.size || item.score > 0).sort((a, b) => Number(a.inCollection) - Number(b.inCollection) || b.score - a.score || a.title!.localeCompare(b.title!)).slice((page - 1) * 12, page * 12 + 1).map(({ score, ...item }) => ({ ...item, relevance: score }));
      return { kind, nextPage: results.length > 12 && page < 500 ? page + 1 : null, personalized: weights.size > 0, genres: ranked.slice(0, 3).map(([genre]) => genre), results: results.slice(0, 12) };
    }));
    return { sections };
  }
  private publicItem(item: HydratedDocument<LibraryItem> & { updatedAt?: Date }) { return { steamImportAppId: item.kind === 'game' ? item.steamImportAppId : undefined, lastWatchedAt: !item.watchedDateUnknown && ['movie', 'series'].includes(item.kind) && item.status === 'completed' ? (item.completedOn && item.completedOn !== item.completedAt?.toISOString().slice(0, 10) ? new Date(item.completedOn + 'T00:00:00Z') : item.completedAt) : undefined, id: item._id.toString(), rewatchWanted: Boolean(item.rewatchWanted), rewatching: Boolean(item.rewatchActiveId), rewatchActiveId: item.rewatchActiveId || null, rewatchCount: item.rewatches?.length || 0, watchedBefore: Boolean(item.rewatches?.length), priority: item.priority || 'none', parentGameCatalogId: item.kind === 'game' ? item.parentGameCatalogId : undefined, platform: item.kind === 'game' ? item.platform || '' : undefined, playtimeMinutes: item.kind === 'game' ? item.playtimeMinutes || 0 : undefined, lastPlayedOn: item.kind === 'game' ? item.lastPlayedOn || null : undefined, title: item.title, originalTitle: item.originalTitle, kind: item.kind, status: item.rewatchActiveId ? 'active' : item.kind === 'movie' && item.status === 'active' ? 'planned' : item.status, archived: Boolean(item.archived), watchedDateUnknown: Boolean(item.watchedDateUnknown), completedOn: item.completedOn, completedAt: item.completedAt, episodesCompletedAt: item.episodesCompletedAt, stars: item.stars || 0, feeling: item.feeling || '', favoriteCharacter: item.favoriteCharacter || '', favoriteCastId: item.favoriteCastId || '', notes: item.notes, updatedAt: item.updatedAt, genres: item.genres || [], catalogId: item.catalogId, coverUrl: item.coverUrl, year: item.year, runtime: item.runtime, productionCompanies: item.productionCompanies, releaseDate: item.releaseDate, unreleased: item.unreleased, overview: item.overview, sourceUrl: item.sourceUrl, ...(item.kind === 'book' ? { authors: item.authors || [], publisher: item.publisher || '', isbn: item.isbn || '', language: item.language || '' } : {}) }; }
  private id(value: string) { if (!/^[a-f0-9]{24}$/i.test(value)) throw new BadRequestException('Item inválido.'); return value; }
  async list(ownerId: string) {
    const items = await this.items.find({ ownerId }, { gameSessions: 0, gameStatusHistory: 0 }).sort({ updatedAt: -1, _id: -1 }).exec();
    // Uma consulta em lote reconhece importações antigas sem conta registrada; não inventa a origem nem grava migração na leitura.
    const gameItems=items.filter(item=>item.kind==='game');
    if(gameItems.length){
      const sources=await this.connection.collection('external_game_data').find({ownerId:new Types.ObjectId(ownerId),provider:'steam',itemId:{$in:gameItems.map(item=>item._id)}},{projection:{itemId:1,externalId:1}}).toArray();
      const origins=new Map(sources.filter(row=>/^[1-9]\d{0,14}$/.test(row.externalId)).map(row=>[row.itemId.toString(),row.externalId]));
      for(const item of gameItems)if(origins.has(item.id))item.steamImportAppId=origins.get(item.id);
    }
    // A coleção é uma leitura local: metadados ausentes não bloqueiam a volta
    // à tela com consultas externas ou gravações título a título no Atlas.
    const missingRelease = items.filter(item => item.releaseDate === undefined && item.catalogKey);
    if (missingRelease.length) {
      const stored = await this.titles.find({ key: { $in: missingRelease.map(item => item.catalogKey!) } }).select('key releaseDate unreleased').lean().exec();
      const releases = new Map(stored.map(title => [title.key, title]));
      for (const item of missingRelease) {
        const title = releases.get(item.catalogKey!);
        if (title?.releaseDate !== undefined) { item.releaseDate = title.releaseDate; item.unreleased = title.unreleased; }
      }
    }
    const games = items.filter(item => item.kind === 'game' && item.catalogId?.startsWith('igdb:game:'));
    if (games.length) {
      // Reconhece DLCs antigas por vínculos já consultados, sem rede nem migração de horas no carregamento.
      const directories = await this.connection.collection<{ _id: string; refs: { id: number; contentType: string }[] }>('catalog_game_addons').find({ 'refs.id': { $in: games.map(item => Number(item.catalogId!.split(':')[2])) } }).toArray();
      for (const game of games) {
        const id = Number(game.catalogId!.split(':')[2]);
        const parent = directories.find(row => row._id !== game.catalogId && row.refs.some(ref => ref.id === id && ref.contentType !== 'standalone-expansion'));
        if (parent) game.parentGameCatalogId = parent._id;
      }
    }
    const series = items.filter(item => item.kind === 'series' && item.catalogId?.startsWith('tmdb:series:'));
    if (!series.length) return items.map(item => this.publicItem(item));
    const [seasons, progress] = await Promise.all([
      this.connection.collection('series_seasons').find({ catalogId: { $in: series.map(item => item.catalogId) }, number: { $gt: 0 } }, { projection: { catalogId: 1, number: 1, loaded: 1, total: 1, 'episodes.number': 1, 'episodes.name': 1, 'episodes.airDate': 1 } }).sort({ number: 1 }).toArray(),
      this.connection.collection('episode_progress').find({ itemId: { $in: series.map(item => viewingProgressId(item)) }, season: { $gt: 0 } }, { projection: { itemId: 1, season: 1, episode: 1, watchedAt: 1 } }).toArray(),
    ]);
    return items.map(item => {
      if (!series.some(value => value.id === item.id)) return this.publicItem(item);
      const available = seasons.filter(season => season.catalogId === item.catalogId);
      const latest = progress.filter(row => row.itemId.toString() === viewingProgressId(item).toString() && row.watchedAt).sort((a, b) => new Date(b.watchedAt).getTime() - new Date(a.watchedAt).getTime() || b.season - a.season || b.episode - a.episode)[0];
      const base = this.publicItem(item);
      const lastWatchedAt = latest && (!base.lastWatchedAt || new Date(latest.watchedAt) >= new Date(base.lastWatchedAt)) ? latest.watchedAt : base.lastWatchedAt;
      const watched = new Set(progress.filter(row => row.itemId.toString() === viewingProgressId(item).toString()).map(row => row.season + ':' + row.episode));
      let next: { season: number; episode: number | null; name?: string; airDate?: string } | null = null;
      let count = 0;
      for (const season of available) {
        const episodes = [...(season.episodes || [])].sort((a, b) => a.number - b.number);
        count += episodes.filter(episode => watched.has(season.number + ':' + episode.number)).length;
        if (next) continue;
        if (!season.loaded) next = { season: season.number, episode: null };
        else {
          const episode = episodes.find(episode => !watched.has(season.number + ':' + episode.number));
          if (episode) next = { season: season.number, episode: episode.number, name: episode.name, airDate: episode.airDate };
        }
      }
      const today = new Date().toISOString().slice(0, 10);
      const pendingReleased = available.flatMap(season => (season.episodes || []).filter((episode: { number: number; airDate?: string }) => (!episode.airDate || episode.airDate <= today) && !watched.has(season.number + ':' + episode.number)).map((episode: { number: number; name: string; airDate?: string }) => ({ season: season.number, episode: episode.number, name: episode.name, airDate: episode.airDate })));
      const caughtUp = watched.size > 0 && available.length > 0 && available.every(season => season.loaded) && pendingReleased.length === 0;
      if (pendingReleased.length) next = pendingReleased[0];
      return { ...base, caughtUp, lastWatchedAt, lastWatchedEpisode: latest ? { season: latest.season, episode: latest.episode } : undefined, status: item.rewatchActiveId ? 'active' : item.status === 'completed' ? 'completed' : watched.size > 0 ? 'active' : 'planned', inProgress: Boolean(item.rewatchActiveId) || (item.status !== 'completed' && watched.size > 0 && !caughtUp), episodeProgress: { next, watched: count, total: available.reduce((sum, season) => sum + (season.loaded ? (season.episodes || []).filter((episode: { airDate?: string }) => !episode.airDate || episode.airDate <= new Date().toISOString().slice(0, 10)).length : season.total || 0), 0), initialized: available.length > 0 } };
    });
  }
  async upcoming(ownerId: string, id: string, language: string) {
    const item = await this.items.findOne({ _id: this.id(id), ownerId, kind: 'series', archived: { $ne: true } }).exec();
    if (!item) throw new NotFoundException('Item não encontrado.');
    const watched = await this.connection.collection('episode_progress').findOne({ itemId: item._id, season: { $gt: 0 } });
    if (!watched) throw new NotFoundException('Item não encontrado.');
    return this.catalog.upcoming(item.catalogId || '', language);
  }
  async movieRuntime(ownerId: string, id: string) {
    const item = await this.owned(ownerId, id);
    if (!['movie', 'series'].includes(item.kind)) throw new BadRequestException('Este título não é um filme ou série.');
    if (item.runtime !== undefined) return { runtime: item.runtime };
    const details = item.catalogId && /^tmdb:(movie|series):[0-9]+$/.test(item.catalogId) ? await this.catalog.detail(item.catalogId) : null;
    const runtime = details?.runtime && details.runtime > 0 ? details.runtime : null;
    await this.items.updateOne({ _id: item._id, ownerId }, { $set: { runtime } });
    if (item.catalogKey) await this.titles.updateOne({ key: item.catalogKey }, { $set: { runtime } });
    return { runtime };
  }
  async movieCompanies(ownerId: string, id: string) {
    const item = await this.owned(ownerId, id);
    if (!['movie', 'series'].includes(item.kind)) throw new BadRequestException('Este título não é um filme ou série.');
    if (item.productionCompanies !== undefined && item.productionCompanies.every(company => company.logoUrl !== undefined)) return { productionCompanies: item.productionCompanies };
    const stored = item.catalogKey ? await this.titles.findOne({ key: item.catalogKey }).lean().exec() : null;
    const details = stored?.productionCompanies !== undefined && stored.productionCompanies.every(company => company.logoUrl !== undefined) ? stored : item.catalogId && /^tmdb:(movie|series):[0-9]+$/.test(item.catalogId) ? await this.catalog.detail(item.catalogId) : null;
    const productionCompanies = (details?.productionCompanies || []).map(company => ({ ...company, logoUrl: company.logoUrl ?? null }));
    await this.items.updateOne({ _id: item._id, ownerId }, { $set: { productionCompanies } });
    if (item.catalogKey) await this.titles.updateOne({ key: item.catalogKey }, { $set: { productionCompanies } });
    return { productionCompanies };
  }
  async stats(ownerId: string) {
    const items = await this.items.find({ ownerId }, { gameSessions: 0, gameStatusHistory: 0 }).lean().exec();
    const series = items.filter(item => item.kind === 'series');
    const [rows, seasons] = await Promise.all([
      this.connection.collection('episode_progress').find({ itemId: { $in: series.map(item => item._id) } }).toArray(),
      this.connection.collection('series_seasons').find({ catalogId: { $in: series.map(item => item.catalogId).filter(Boolean) } }).toArray(),
    ]);
    let minutes = 0, missing = 0;
    const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
    const characters = new Map<string, { name: string; itemId: string; title: string; count: number }>();
    const votes: import('./actor-votes').Vote[] = [];
    const addVote = (item: typeof items[number], name?: string, season?: number, episode?: number, identity?: { favoriteActorId?: string; favoriteActorName?: string; favoriteActorPhoto?: string }) => {
      if (!name?.trim()) return;
      votes.push({ ...identity, itemId: item._id.toString(), title: item.title, catalogId: item.catalogId, kind: item.kind, name, season, episode });
      const key = (item.catalogId || item._id.toString()) + ':' + normalize(name);
      const vote = characters.get(key) || { name: name.trim(), itemId: item._id.toString(), title: item.title, count: 0 };
      vote.count++; characters.set(key, vote);
    };
    for (const item of items.filter(item => ['movie', 'series'].includes(item.kind) && item.status === 'completed')) addVote(item, item.favoriteCharacter, undefined, undefined, item);
    for (const row of rows) { const item = series.find(item => item._id.toString() === row.itemId.toString()); if (item) addVote(item, row.favoriteCharacter, row.season, row.episode, { favoriteActorId: row.favoriteActorId, favoriteActorName: row.favoriteActorName, favoriteActorPhoto: row.favoriteActorPhoto }); }
    const genres = (selected: typeof items) => {
      const counts = new Map<string, { name: string; count: number }>();
      for (const item of selected) for (const key of new Set((item.genres || []).map(normalize).filter(Boolean))) {
        const value = counts.get(key) || { name: (item.genres || []).find(genre => normalize(genre) === key)!, count: 0 };
        value.count++; counts.set(key, value);
      }
      return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    };
    const watchedSeriesIds = new Set(rows.map(row => row.itemId.toString()));
    const catalogIds = [...new Set(votes.map(vote => vote.catalogId).filter((id): id is string => !!id && /^tmdb:(movie|series):[0-9]+$/.test(id)))];
    const caches = catalogIds.length ? await this.connection.collection<CastCache>('catalog_cast').find({ _id: { $in: catalogIds.map(id => new RegExp('^' + id + ':')) } }, { projection: { _id: 1, cast: 1 } }).toArray() : [];
    const companyWatched = (item: typeof items[number]) => item.status === 'completed' || (item.kind === 'series' && rows.some(row => row.itemId.toString() === item._id.toString()));
    const countCompanies = (kind: string, watchedOnly = false) => {
    const companies = new Map<number, { id: number; name: string; logoUrl?: string | null; count: number }>();
    for (const item of items.filter(item => item.kind === kind && (!watchedOnly || companyWatched(item)))) {
      for (const company of new Map((item.productionCompanies || []).map(company => [company.id, company])).values()) {
        const entry = companies.get(company.id) || { id: company.id, name: company.name, ...(company.logoUrl !== undefined ? { logoUrl: company.logoUrl } : {}), count: 0 };
        if (!entry.logoUrl && company.logoUrl) entry.logoUrl = company.logoUrl;
        entry.count++; companies.set(company.id, entry);
      }
    }
    return [...companies.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    };
    const feelingSources = new Map<string, { itemId: string; title: string; kind: string; feeling: string; count: number }>();
    const addFeeling = (item: typeof items[number], feeling?: string) => {
      if (!feeling) return;
      const key = item._id.toString() + ':' + feeling;
      const source = feelingSources.get(key) || { itemId: item._id.toString(), title: item.title, kind: item.kind, feeling, count: 0 };
      source.count++; feelingSources.set(key, source);
    };
    for (const item of items.filter(item => item.kind === 'movie' && item.status === 'completed')) addFeeling(item, item.feeling);
    for (const row of rows) { const item = series.find(item => item._id.toString() === row.itemId.toString()); if (item) addFeeling(item, row.feeling); }
    const preferences = {
      watchedMovieCompanies: countCompanies('movie', true),
      watchedSeriesCompanies: countCompanies('series', true),
      watchedMoviesMissingCompanies: items.filter(item => item.kind === 'movie' && companyWatched(item) && !item.productionCompanies?.length).length,
      watchedSeriesMissingCompanies: items.filter(item => item.kind === 'series' && companyWatched(item) && !item.productionCompanies?.length).length,
      feelingSources: [...feelingSources.values()],
      productionCompanies: countCompanies('movie'),
      seriesProductionCompanies: countCompanies('series'),
      seriesMissingCompanies: items.filter(item => item.kind === 'series' && !item.productionCompanies?.length).length,
      moviesMissingCompanies: items.filter(item => item.kind === 'movie' && !item.productionCompanies?.length).length,
      ...actorVotes(votes, caches),
      characters: [...characters.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      addedGenres: genres(items.filter(item => item.kind !== 'book')),
      watchedGenres: genres(items.filter(item => item.kind === 'movie' ? item.status === 'completed' : item.kind === 'series' && (item.status === 'completed' || watchedSeriesIds.has(item._id.toString())))),
      seriesFeelings: series.map(item => {
        const counts = new Map<string, number>();
        for (const row of rows.filter(row => row.itemId.toString() === item._id.toString())) if (row.feeling) counts.set(row.feeling, (counts.get(row.feeling) || 0) + 1);
        const max = Math.max(0, ...counts.values());
        return { itemId: item._id.toString(), title: item.title, feelings: [...counts].filter(([, count]) => count === max).map(([feeling, count]) => ({ feeling, count })), ratedEpisodes: [...counts.values()].reduce((a, b) => a + b, 0) };
      }).filter(item => item.ratedEpisodes > 0).sort((a, b) => b.ratedEpisodes - a.ratedEpisodes || a.title.localeCompare(b.title)),
    };
    const bySeries = series.map(item => {
      const watched = rows.filter(row => row.itemId.toString() === item._id.toString());
      let runtime = 0, unknown = 0;
      for (const row of watched) {
        const season = seasons.find(season => season.catalogId === item.catalogId && season.number === row.season);
        const episode = season?.episodes?.find((episode: { number: number }) => episode.number === row.episode);
        if (typeof episode?.runtime === 'number' && episode.runtime > 0) runtime += episode.runtime; else unknown++;
      }
      minutes += runtime; missing += unknown;
      return { id: item._id.toString(), title: item.title, episodes: watched.length, minutes: runtime, missingRuntime: unknown };
    }).filter(item => item.episodes > 0).sort((a, b) => b.minutes - a.minutes || b.episodes - a.episodes);
    const movies = items.filter(item => item.kind === 'movie' && item.status === 'completed');
    const movieMinutes = movies.reduce((sum, item) => sum + (typeof item.runtime === 'number' && item.runtime > 0 ? item.runtime : 0), 0);
    const moviesMissingRuntime = movies.filter(item => !item.runtime || item.runtime <= 0).length;
    let totalEpisodes = 0, seriesMissingTotals = 0;
    for (const item of series) {
      const directory = seasons.filter(season => season.catalogId === item.catalogId && season.number > 0);
      const watched = rows.filter(row => row.itemId.toString() === item._id.toString());
      const released = new Set<string>(watched.map(row => row.season + ':' + row.episode));
      const today = new Date().toISOString().slice(0, 10);
      let incomplete = !directory.length;
      for (const season of directory) {
        if (!season.loaded) incomplete = true;
        for (const episode of season.episodes || []) {
          const key = season.number + ':' + episode.number;
          const date = episode.airDate;
          const validDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
          if (validDate && date <= today) released.add(key);
          else if (!validDate && !released.has(key)) incomplete = true;
        }
      }
      if (incomplete) seriesMissingTotals++;
      totalEpisodes += released.size;
    }
    return { totalEpisodes, seriesMissingTotals, movieMinutes, moviesMissingRuntime, episodes: rows.length, seriesWatched: bySeries.length, seriesCompleted: series.filter(item => item.status === 'completed').length, moviesCompleted: items.filter(item => item.kind === 'movie' && item.status === 'completed').length, minutes, missingRuntime: missing, pendingSeries: series.filter(item => item.status === 'completed' && (!item.catalogId || !item.episodesCompletedAt)).length, bySeries, preferences };
  }
  async create(ownerId: string, dto: ItemDto) {
    if (dto.kind === 'movie' && dto.status === 'active') dto.status = 'planned';
    const { catalogId, ...manual } = dto;
    const stored = catalogId ? await this.titles.findOne({ key: catalogId }).exec() : undefined;
    if (catalogId?.startsWith('local:') && !stored) throw new BadRequestException('Título não encontrado no NextPlay.');
    const details = stored ? this.metadata(stored) : catalogId ? catalogId.startsWith('googlebooks:book:') ? await this.books.detail(catalogId) : await this.catalog.detail(catalogId) : undefined;
    if (details && details.kind !== dto.kind) throw new BadRequestException('A categoria não corresponde ao título selecionado.');
    // Acompanhamento de leitura registra intenção/progresso; nunca cria ou altera exemplares no acervo.
    const payload = { ...manual, ...details, parentGameCatalogId: dto.kind === 'game' && catalogId ? await this.catalog.cachedGameParent(catalogId) : undefined, priority: dto.priority || 'none', ...(dto.kind === 'book' ? { bookMetadataVersion: catalogId ? 1 : 0 } : {}), genres: [...new Set((dto.kind === 'game' ? dto.genres ?? details?.genres ?? [] : details?.genres ?? manual.genres ?? []).map(value => value.trim()).filter(Boolean))], playtimeMinutes: dto.kind === 'game' ? dto.playtimeMinutes ?? 0 : 0, platform: dto.kind === 'game' ? (dto.platform || '').trim() : '' };
    const completion = await this.completion(dto, undefined, catalogId);
    const allEpisodes = dto.status === 'completed' && payload.kind === 'series' && details?.catalogId?.startsWith('tmdb:series:') ? await this.episodes.prepareCompletion(details.catalogId!) : null;
    const catalogKey = await this.remember(payload);
    if (await this.items.exists({ ownerId, catalogKey })) throw new ConflictException('Este título já está na sua coleção.');
    try { const item = await this.items.create({ ...payload, ...completion, ...(payload.kind === 'game' ? { gameStatusHistory: [gameStatusEvent('added', null, dto.status)] } : {}), catalogKey, ownerId }); if (allEpisodes) { await this.episodes.markComplete(item._id, allEpisodes, item.completedAt || new Date()); item.episodesCompletedAt = new Date(); } await recordSocialActivity(this.connection, item._id, dto.status === 'completed' ? 'completed' : dto.status === 'active' ? 'started' : 'added', `added:${item.id}`); return this.publicItem(item); }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new ConflictException('Este título já está na sua coleção.'); throw error; }
  }
  async update(ownerId: string, id: string, dto: ItemDto) {
    const existing = await this.items.findOne({ _id: this.id(id), ownerId }).exec();
    if (!existing) throw new NotFoundException('Item não encontrado.');
    if ((dto.viewingId !== undefined || existing.rewatchActiveId) && (dto.viewingId || 'original') !== (existing.rewatchActiveId || 'original')) throw new ConflictException('A visualização mudou. Atualize o acompanhamento.');
    // Uma nova visualização nunca regrava a conclusão, nota ou votos da primeira.
    if (existing.rewatchActiveId) {
      if (dto.kind !== existing.kind || !['active', 'completed'].includes(dto.status)) throw new BadRequestException('Use o acompanhamento da visualização atual para reassistir.');
      if (dto.status === 'completed') await this.rewatches.change(ownerId, id, { action: 'finish', expectedCount: existing.rewatches?.length || 0, watchedDateUnknown: dto.watchedDateUnknown, completedOn: dto.completedOn });
      await this.items.updateOne({ _id: existing._id, ownerId }, { $set: { notes: dto.notes ?? existing.notes, ...(dto.priority !== undefined ? { priority: dto.priority } : {}) } });
      return (await this.list(ownerId)).find(item => item.id === id)!;
    }
    if (existing.rewatches?.length && (dto.kind !== existing.kind || dto.status !== existing.status)) throw new BadRequestException('Use Quero rever para iniciar outra visualização sem apagar o histórico.');
    if ((existing.catalogId ? existing.kind : dto.kind) === 'movie' && dto.status === 'active') dto.status = 'planned';
    if (dto.catalogId && dto.catalogId !== existing.catalogId) throw new BadRequestException('Não é possível trocar a referência deste título.');
    const allEpisodes = dto.status === 'completed' && existing.kind === 'series' && existing.catalogId?.startsWith('tmdb:series:') && (existing.status !== 'completed' || !existing.episodesCompletedAt) ? await this.episodes.prepareCompletion(existing.catalogId) : null;
    // Tempo jogado pertence ao acompanhamento e permanece ao mudar o status, mesmo sem avaliação de conclusão.
    const changes = existing.catalogId ? { status: dto.status, notes: dto.notes ?? '', genres: existing.kind === 'book' ? existing.genres : dto.genres ?? existing.genres } : { title: dto.title, kind: dto.kind, status: dto.status, notes: dto.notes ?? '', genres: dto.genres ?? existing.genres };
    const isGame = (existing.catalogId ? existing.kind : dto.kind) === 'game';
    if (!isGame && existing.gameSessions?.length) throw new BadRequestException('Remova as sessões antes de alterar a categoria do jogo.');
    if (isGame && dto.playtimeMinutes !== undefined && dto.playtimeMinutes < sessionMinutes(existing.gameSessions)) throw new BadRequestException('O total não pode ser menor que as sessões registradas. Edite as sessões primeiro.');
    const item = await this.items.findOneAndUpdate({ _id: this.id(id), ownerId, status: existing.status, ...(isGame && dto.playtimeMinutes !== undefined ? { $expr: { $and: [{ $eq: [{ $ifNull: ['$gameSessionRevision', 0] }, existing.gameSessionRevision || 0] }, { $eq: [{ $ifNull: ['$playtimeMinutes', 0] }, existing.playtimeMinutes || 0] }] } } : {}) }, { ...(isGame && existing.status !== dto.status ? { $push: { gameStatusHistory: gameStatusEvent('status', existing.status, dto.status) } } : {}), ...(isGame && dto.playtimeMinutes !== undefined ? { $inc: { gameSessionRevision: 1 } } : {}), $set: { ...changes, ...(dto.priority !== undefined ? { priority: dto.priority } : {}), ...(!isGame ? { playtimeMinutes: 0, lastPlayedOn: null } : dto.playtimeMinutes !== undefined ? { playtimeMinutes: dto.playtimeMinutes } : {}), platform: (existing.catalogId ? existing.kind : dto.kind) === 'game' ? (dto.platform ?? existing.platform ?? '').trim() : '', ...await this.completion(dto, existing) } }, { returnDocument: 'after', runValidators: true }).exec();
    if (!item) throw new ConflictException('O acompanhamento mudou em outra aba. Atualize e tente novamente.');
    if (allEpisodes) { await this.episodes.markComplete(item._id, allEpisodes, item.completedAt || new Date()); item.episodesCompletedAt = new Date(); }
    const key = await this.remember(item);
    await this.titles.updateOne({ key }, { $set: this.metadata(item) });
    if (item.catalogKey !== key) { item.catalogKey = key; await item.save(); }
    if (existing.status !== item.status && ['active', 'completed'].includes(item.status)) await recordSocialActivity(this.connection, item._id, item.status === 'completed' ? 'completed' : 'started');
    else await recordPrivateActivity(this.connection,item,existing.status!==item.status?'planned':'edited');
    return this.publicItem(item);
  }
  async gameTime(ownerId: string, id: string, dto: GameTimeDto) {
    if (dto.mode === 'add' && dto.minutes === 0) throw new BadRequestException('Informe pelo menos um minuto jogado.');
    const filter = { _id: this.id(id), ownerId, kind: 'game' };
    const previousStatus = (await this.items.findOne(filter).select('status').lean().exec())?.status;
    // A soma ocorre no banco, evitando perder horas quando duas abas registram tempo juntas.
    const item = await this.items.findOneAndUpdate({ ...filter, ...(dto.expectedTotal !== undefined ? { $and: [{ $expr: { $eq: [{ $ifNull: ['$playtimeMinutes', 0] }, dto.expectedTotal] } }] } : {}), ...(dto.mode === 'add' ? { $or: [{ playtimeMinutes: { $lte: 6000000 - dto.minutes } }, { playtimeMinutes: { $exists: false } }] } : { $expr: { $gte: [dto.minutes, { $sum: '$gameSessions.minutes' }] } }) }, [
      { $set: {
        // Evento e estado são gravados juntos; reenvios com o jogo já ativo não criam outro início.
        gameStatusHistory: { $concatArrays: [{ $ifNull: ['$gameStatusHistory', []] }, { $cond: [{ $and: [{ $eq: ['$status', 'planned'] }, { $gt: [dto.minutes, 0] }] }, { $literal: [gameStatusEvent('status', 'planned', 'active', 'time-adjustment')] }, []] }] },
        playtimeMinutes: dto.mode === 'add' ? { $add: [{ $ifNull: ['$playtimeMinutes', 0] }, dto.minutes] } : dto.minutes,
        // Ajustes sem data alteram o saldo anterior e não inventam sessões.
        gameSessionRevision: { $add: [{ $ifNull: ['$gameSessionRevision', 0] }, 1] },
        // Jogar um título planejado inicia o acompanhamento; jogos concluídos mantêm sua conclusão.
        status: dto.minutes > 0 ? { $cond: [{ $eq: ['$status', 'planned'] }, 'active', '$status'] } : '$status',
      } },
    ], { returnDocument: 'after', updatePipeline: true }).exec();
    if (!item) {
      const current = await this.items.findOne(filter).select('playtimeMinutes').lean().exec();
      if (current && dto.expectedTotal !== undefined && dto.expectedTotal !== (current.playtimeMinutes || 0)) throw new ConflictException('O total mudou em outra aba. Atualize e tente novamente.');
      if (current) throw new BadRequestException('O total deve respeitar o limite e não pode ser menor que as sessões registradas.');
      throw new NotFoundException('Jogo não encontrado.');
    }
    if (previousStatus === 'planned' && item.status === 'active') await recordSocialActivity(this.connection, item._id, 'started', `game-time:${item.gameStatusHistory?.at(-1)?.id}`);
    return this.publicItem(item);
  }
  async archive(ownerId: string, id: string, archived: boolean) {
    const previous = await this.owned(ownerId, id);
    if (Boolean(previous.archived) === archived) return this.publicItem(previous);
    // A comparação protege o motivo registrado contra uma mudança concorrente de status/arquivo.
    const item = await this.items.findOneAndUpdate({ _id: this.id(id), ownerId, ...(previous.kind === 'game' ? { status: previous.status, $expr: { $eq: [{ $ifNull: ['$archived', false] }, Boolean(previous.archived)] } } : {}) }, {
      $set: { archived },
      ...(previous.kind === 'game' ? { $push: { gameStatusHistory: gameStatusEvent(archived ? 'archived' : 'restored', previous.status, previous.status) } } : {}),
    }, { returnDocument: 'after', runValidators: true }).exec();
    if (!item) throw new ConflictException('O acompanhamento mudou em outra aba. Atualize e tente novamente.');
    await recordPrivateActivity(this.connection,item,archived?'archived':'restored');
    return this.publicItem(item);
  }
  async gameStatusHistory(ownerId: string, id: string, before?: string) {
    const item = await this.items.findOne({ _id: this.id(id), ownerId }).select('kind gameStatusHistory').lean().exec();
    if (!item) throw new NotFoundException('Item não encontrado.');
    if (item.kind !== 'game') throw new BadRequestException('Histórico disponível somente para jogos.');
    const history = item.gameStatusHistory || [];
    const end = before ? history.findIndex(event => event.id === before) : history.length;
    if (end < 0) throw new BadRequestException('Cursor de histórico inválido para este jogo.');
    const start = Math.max(0, end - 30);
    return { events: history.slice(start, end).reverse(), nextBefore: start > 0 ? history[start].id : null, earlierHistoryUnknown: history[0]?.type !== 'added' };
  }
  async priority(ownerId: string, id: string, priority: string) {
    // A alteração isolada evita regravar avaliações, sessões e metadados do catálogo.
    const item = await this.items.findOneAndUpdate({ _id: this.id(id), ownerId }, { $set: { priority } }, { returnDocument: 'after', runValidators: true }).exec();
    if (!item) throw new NotFoundException('Item não encontrado.');
    return this.publicItem(item);
  }
  async remove(ownerId: string, id: string) {
 
    const item = await this.items.findOneAndDelete({ _id: this.id(id), ownerId }).exec();
    if (!item) throw new NotFoundException('Item não encontrado.');
    await this.connection.collection('episode_progress').deleteMany({ itemId: { $in: [item._id, ...(item.rewatches || []).map(cycle => new Types.ObjectId(cycle.id))] } });
    await recordPrivateActivity(this.connection,item,'deleted');
  }
}
@ApiTags('library')
@ApiCookieAuth('session')
@Controller('library')
class LibraryController {
  constructor(private readonly library: LibraryService, private readonly auth: AuthService, private readonly catalog: CatalogService, private readonly rewatches: RewatchService) {}
  private async language(request: Request) { return (await this.auth.forRequest(request)).language; }
  private async owner(request: Request) {
    if (request.method !== 'GET' && request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem da requisição não permitida.');
    return (await this.auth.forRequest(request)).id;
  }
  @Get(':id/rewatches')
  @ApiOperation({ summary: 'Histórico privado de visualizações de filmes e séries', description: 'A primeira visualização mantém as datas e episódios existentes. Cada repetição possui início e conclusão próprios, com episódios e datas separados. Sem alterar XP ou contagens por títulos distintos.' })
  @ApiOkResponse({ description: 'Até dez entries em ordem decrescente e nextBefore (número ou null). Cada entrada: id, number, original, active, startedAt opcional, completedAt/completedOn opcionais, watchedDateUnknown e episodes (season, episode, watchedAt nullable, watchedDateUnknown).' })
  @ApiResponse({ status: 404, description: 'Título inexistente ou de outra conta.' })
  @ApiQuery({ name: 'before', required: false, type: Number, description: 'nextBefore da página anterior. Inteiro de 2 a 1001; dez visualizações por página.' })
  async rewatchHistory(@Req() request: Request, @Param('id') id: string, @Query('before') before?: string) {
    if (before !== undefined && (!/^\d+$/.test(before) || Number(before) < 2 || Number(before) > 1001)) throw new BadRequestException('Cursor de visualizações inválido.');
    return this.rewatches.history(await this.owner(request), id, before === undefined ? undefined : Number(before));
  }
  @Post(':id/rewatches') @HttpCode(200)
  @ApiOperation({ summary: 'Planejar, iniciar ou concluir outra visualização', description: 'Somente filmes e séries já assistidos e não arquivados. Mantém a primeira conclusão, avaliações e episódios. Uma visualização ativa por título; até 1000 repetições. expectedCount evita duplicações concorrentes. Séries TMDB só encerram após assistir todos os episódios regulares já lançados; séries manuais encerram sem progresso por episódio; também é possível Concluir série no acompanhamento. Não concede XP adicional.' })
  @ApiOkResponse({ description: 'item com rewatchWanted, rewatching, rewatchCount, watchedBefore e progresso da visualização atual.' })
  @ApiResponse({ status: 400, description: 'Ação, data, categoria ou estado inválidos; série com episódios pendentes.' })
  @ApiResponse({ status: 409, description: 'Histórico alterado ou visualização já em andamento.' })
  @ApiResponse({ status: 404, description: 'Título inexistente ou de outra conta.' })
  async rewatch(@Req() request: Request, @Param('id') id: string, @Body() dto: RewatchDto) {
    const owner = await this.owner(request);
    await this.rewatches.change(owner, id, dto);
    return { item: await this.catalog.localize((await this.library.list(owner)).find(item => item.id === id)!, await this.language(request), false) };
  }
  @ApiOperation({ summary: 'Consultar comentários e nota agregada da comunidade', description: 'Título na biblioteca da sessão. ratingSummary retorna média anônima de 1 a 5 (null sem notas), count de pessoas e distribution por estrela. Usa a avaliação mais recente por autor entre títulos concluídos com a mesma identidade, incluindo arquivados. Não divulga avaliações individuais ou anotações. Comentários paginados em ordem decrescente; next usado como before.' })
  @Get(':id/community') async community(@Req() request: Request, @Param('id') id: string, @Query('before') before?: string) { return this.library.community(await this.owner(request), id, before); }
  @Get(':id/cast') async cast(@Req() request: Request, @Param('id') id: string, @Query('season') season?: string, @Query('episode') episode?: string) { return this.library.cast(await this.owner(request), id, await this.language(request), season === undefined ? undefined : Number(season), episode === undefined ? undefined : Number(episode)); }
  @Get(':id/comments/:commentId/thread')
  @ApiOperation({ summary: 'Consultar conversa e respostas de um comentário', description: 'Exige título na biblioteca da sessão. Retorna comment (raiz), replies (até 20, em ordem de publicação) e next (cursor after ou null). Inclui likeCount, liked da sessão e replyCount. Autores usam pseudônimo por título; não expõe IDs de quem curtiu. Comentários removidos são marcadores sem texto, preservando respostas.' })
  @ApiQuery({ name: 'after', required: false, type: String, description: 'ID next da página anterior.' })
  async commentThread(@Req() request: Request, @Param('id') id: string, @Param('commentId') commentId: string, @Query('after') after?: string) { return this.library.commentThread(await this.owner(request), id, commentId, after); }
  @Post(':id/comments/:commentId/replies')
  @ApiOperation({ summary: 'Responder a comentário do mesmo título', description: 'Uma camada de respostas por comentário principal. Texto de 1 a 2000 caracteres. Notifica somente o autor do comentário principal, se for outra pessoa. clientRequestId UUID evita duplicação em reenvios. Não permite responder raiz removida ou outra resposta. Retorna comment com contagem/estado de curtidas e parentReplyCount confirmado para a raiz, inclusive nos reenvios.' })
  @ApiResponse({ status: 409, description: 'Chave de publicação reutilizada com outros dados.' })
  async reply(@Req() request: Request, @Param('id') id: string, @Param('commentId') commentId: string, @Body() dto: CommentDto) { return this.library.reply(await this.owner(request), id, commentId, dto); }
  @Patch(':id/comments/:commentId/like')
  @ApiOperation({ summary: 'Curtir ou retirar a própria curtida', description: 'Estado explícito e idempotente. Exige título na biblioteca e comentário/resposta disponível do mesmo título. Retorna liked e likeCount; não concede XP nem notifica curtidas.' })
  async commentLike(@Req() request: Request, @Param('id') id: string, @Param('commentId') commentId: string, @Body() dto: CommentLikeDto) { return this.library.commentLike(await this.owner(request), id, commentId, dto.liked); }
  @ApiOperation({ summary: 'Publicar comentário sobre título', description: 'Exige título na biblioteca. Texto público a participantes do mesmo título; autor usa pseudônimo por título. clientRequestId opcional evita repetição de publicações. Listagem paginada em community inclui contagem/estado de curtidas e quantidade de respostas.' })
  @Post(':id/comments') @HttpCode(204) async comment(@Req() request: Request, @Param('id') id: string, @Body() dto: CommentDto) { await this.library.comment(await this.owner(request), id, dto); }
  @ApiOperation({ summary: 'Remover o próprio comentário ou resposta', description: 'Somente o autor. Remove texto e curtidas, preservando um marcador e as respostas de outras pessoas. Reenvio é idempotente.' })
  @Delete(':id/comments/:commentId') @HttpCode(204) async deleteComment(@Req() request: Request, @Param('id') id: string, @Param('commentId') commentId: string) { await this.library.deleteComment(await this.owner(request), id, commentId); }
  @Get(':id/upcoming') async upcoming(@Req() request: Request, @Param('id') id: string) { return this.library.upcoming(await this.owner(request), id, await this.language(request)); }
  @Get(':id/game-status-history')
  @ApiOperation({ summary: 'Consultar histórico privado de status do jogo', description: 'Registra somente alterações novas: adição, mudança real de status, arquivamento/restauração e início automático ao registrar horas/sessão. Datas recordedAt são do servidor no momento da alteração, nunca datas antigas de consumo. Jogos legados não recebem eventos inventados. Cada DLC mantém seu próprio histórico. Eventos gravados atomicamente com a alteração; consultas e reavaliações sem mudança de estado não criam eventos.' })
  @ApiOkResponse({ description: 'events: até 30 objetos com id UUID, type (added/status/archived/restored), fromStatus nullable, toStatus (planned/active/completed), source (manual/session/time-adjustment), recordedAt ISO. Mais recentes primeiro. nextBefore UUID ou null; earlierHistoryUnknown indica ausência de registro da adição original.' })
  @ApiResponse({ status: 400, description: 'Item não é jogo, ID/cursor inválido ou cursor de outro jogo.' })
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @ApiResponse({ status: 404, description: 'Item inexistente ou de outra conta.' })
  async gameStatusHistory(@Req() request: Request, @Param('id') id: string, @Query() query: GameStatusHistoryQuery) { return this.library.gameStatusHistory(await this.owner(request), id, query.before); }
  @Get(':id/game-addons')
  @ApiOperation({ summary: 'Consultar expansões e DLCs do jogo', description: 'Somente o dono. Vínculos explícitos da IGDB: DLC, expansão e expansão independente. Consulta sob demanda com cache público por jogo/idioma/página por um dia. Não adiciona conteúdos automaticamente nem modifica o jogo principal. Jogo sem IGDB retorna supported=false. Falhas do provedor não são armazenadas como lista vazia.' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 1 } })
  @ApiOkResponse({ description: 'supported, results (até 20 títulos de catálogo com contentType: dlc/expansion/standalone-expansion), total de vínculos e nextPage (número ou null). Títulos removidos podem resultar em página vazia com nextPage. trackedParts contém somente os acompanhamentos dependentes do dono, com parentGameCatalogId e tempos separados, para agrupar cards sem duplicar estatísticas.' })
  @ApiResponse({ status: 400, description: 'Página inválida ou item não é jogo.' })
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @ApiResponse({ status: 404, description: 'Item inexistente ou de outra conta.' })
  @ApiResponse({ status: 429, description: 'Limite de consultas atingido.' })
  @ApiResponse({ status: 502, description: 'Resposta inválida ou falha da IGDB.' })
  @ApiResponse({ status: 503, description: 'IGDB indisponível ou sem configuração.' })
  async gameAddons(@Req() request: Request, @Param('id') id: string, @Query('page') page?: string) { return this.library.gameAddons(await this.owner(request), id, await this.language(request), page === undefined ? 1 : Number(page)); }
  @Get(':id/game-estimate')
  @ApiOperation({ summary: 'Consultar estimativas de duração do jogo pela IGDB', description: 'Somente o dono. Consulta sob demanda, sem alterar horas, conclusão ou XP. Retorna minutos para história principal, extras e 100%, e quantidade de contribuições. Tempos ausentes/zero/inválidos são null. Jogo sem vínculo IGDB retorna supported=false. Cache público por jogo por sete dias; ausência por um dia. Falhas do provedor não são armazenadas como ausência.' })
  @ApiOkResponse({ type: GameEstimateDto })
  @ApiResponse({ status: 400, description: 'Item inválido ou não é jogo.' })
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @ApiResponse({ status: 404, description: 'Item inexistente ou de outra conta.' })
  @ApiResponse({ status: 429, description: 'Limite de consultas atingido.' })
  @ApiResponse({ status: 502, description: 'Falha ou resposta inválida do provedor.' })
  @ApiResponse({ status: 503, description: 'IGDB indisponível ou sem credenciais no servidor.' })
  async gameEstimate(@Req() request: Request, @Param('id') id: string) { return this.library.gameEstimate(await this.owner(request), id); }
  @Get(':id/directors') async directors(@Req() request: Request, @Param('id') id: string) { return this.library.directors(await this.owner(request), id); }
  @Get(':id/trailer') async trailer(@Req() request: Request, @Param('id') id: string) { return this.library.trailer(await this.owner(request), id, await this.language(request)); }
  @Post(':id/production-companies') async movieCompanies(@Req() request: Request, @Param('id') id: string) { return this.library.movieCompanies(await this.owner(request), id); }
  @Post(':id/runtime') async movieRuntime(@Req() request: Request, @Param('id') id: string) { return this.library.movieRuntime(await this.owner(request), id); }
  @Get('stats') async stats(@Req() request: Request) { const owner = await this.owner(request); return this.library.rankingVisit(owner, request.get('X-Ranking-Visit')); }
  @Get('explore')
  @ApiOperation({ summary: 'Explorar filmes, séries, jogos e livros', description: 'Filmes/séries consideram gêneros do acompanhamento e a ordem de popularidade do TMDB; a ordem retornada preserva afinidade e popularidade. Livros vêm do Google Books e usam somente o acompanhamento privado de leitura da sessão, priorizando título, autor e editora. Sugestões personalizadas e gerais incluem somente edições no idioma do perfil (pt-BR/en-US/es-ES), independentemente do idioma dos livros salvos. Retorna unavailable=true na seção cujo provedor falhar, preservando as demais categorias; a ordem dos livros já representa a afinidade.' })
  @ApiQuery({ name: 'kind', required: false, enum: ['movie', 'series', 'game', 'book'], description: 'Sem filtro, retorna as quatro categorias.' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 1 }, description: 'Máximo 50 para livros ou sem filtro; máximo 500 para as demais categorias. nextPage=null encerra a paginação.' })
  @ApiOkResponse({ description: 'Seções com kind, source (tmdb/googlebooks quando externo), personalized, genres, results, nextPage e unavailable quando houver falha. TMDB inclui totalPages opcional, entre 0 e 500, para sortear páginas válidas de todo o catálogo filtrado. Livros incluem autores, editora, ano, capa e sourceUrl; não incluem dados privados de leitura.' })
  @ApiResponse({ status: 400, description: 'Página ou categoria inválida.' })
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @ApiResponse({ status: 429, description: 'Limite de requisições atingido.' })
  async explore(@Req() request: Request, @Query('page') page?: string, @Query('kind') kind?: string) { const owner = await this.owner(request); const language = await this.language(request); this.catalog.limit(owner); const result = await this.library.explore(owner, language, page === undefined ? 1 : Number(page), kind); return { sections: await Promise.all(result.sections.map(async section => ({ ...section, results: 'source' in section && (section.source === 'tmdb' || section.source === 'googlebooks') ? section.results : await Promise.all(section.results.map(item => this.catalog.localize(item, language))) }))) }; }
  @Get()
  @ApiOperation({ summary: 'Listar acompanhamento privado, incluindo livros', description: 'Filmes, séries, jogos e leitura. Jogos importados podem incluir steamImportAppId para link do jogo na Steam; a conta de origem é privada e só aparece em game-imports/stats do dono. Jogos podem incluir parentGameCatalogId, vínculo público IGDB de DLC/expansão dependente; playtimeMinutes permanece exclusivo de cada parte, sem total duplicado. Livros não são importados automaticamente da Minha Coleção.' })
  async list(@Req() request: Request) { return { items: await this.catalog.localizeMany(await this.library.list(await this.owner(request)), await this.language(request)) }; }
  @Post()
  @ApiOperation({ summary: 'Adicionar obra ao acompanhamento', description: 'Livros aceitam cadastro manual ou Google Books e estados Quero ler/Lendo/Lido. Uma obra por usuário/referência; não cria cópia possuída. Conclusão aceita data e nota opcionais.' })
  async create(@Req() request: Request, @Body() dto: ItemDto) { return { item: await this.catalog.localize(await this.library.create(await this.owner(request), dto), await this.language(request)) }; }
  @Patch(':id')
  @ApiResponse({ status: 409, description: 'O acompanhamento ou tempo de jogo mudou durante a edição; atualize antes de reenviar.' })
  @ApiOperation({ summary: 'Atualizar acompanhamento privado', description: 'Para livros, altera estado de leitura, data, nota e anotações. Voltar de Lido remove os dados de conclusão. Somente dono; não altera exemplares da Minha Coleção.' })
  async update(@Req() request: Request, @Param('id') id: string, @Body() dto: ItemDto) { return { item: await this.catalog.localize(await this.library.update(await this.owner(request), id, dto), await this.language(request)) }; }
  @Delete(':id') @HttpCode(204) async remove(@Req() request: Request, @Param('id') id: string) { await this.library.remove(await this.owner(request), id); }
  @Patch(':id/priority')
  @ApiOperation({ summary: 'Alterar prioridade privada do backlog', description: 'Alta, média, baixa ou nenhuma. Não altera conclusão, progresso, notas, horas ou sessões. A ordenação por prioridade se aplica à tela Para depois. Não concede XP.' })
  @ApiOkResponse({ description: 'Objeto item atualizado, incluindo priority.' })
  @ApiResponse({ status: 400, description: 'Prioridade inválida ou campos não permitidos.' })
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @ApiResponse({ status: 403, description: 'Origem não permitida.' })
  @ApiResponse({ status: 404, description: 'Item inexistente ou de outra conta.' })
  async priority(@Req() request: Request, @Param('id') id: string, @Body() dto: PriorityDto) { return { item: await this.catalog.localize(await this.library.priority(await this.owner(request), id, dto.priority), await this.language(request), false) }; }
  @Patch(':id/playtime')
  @ApiResponse({ status: 409, description: 'expectedTotal não corresponde ao total atual; atualize antes de ajustar o saldo.' })
  @ApiOperation({ summary: 'Registrar tempo jogado rapidamente', description: 'Somente jogos do dono. Soma minutos atomicamente ou substitui o total. Não altera notas, plataforma ou conclusão. Jogos planejados passam para Jogando. Ajuste sem data: preserva as sessões e altera somente o saldo anterior. O novo total não pode ser menor que a soma das sessões; para registrar um dia de jogo use /game-sessions.' })
  @ApiOkResponse({ description: 'Objeto item atualizado, com playtimeMinutes em minutos.' })
  @ApiResponse({ status: 400, description: 'Modo/minutos inválidos, soma zero ou total acima de 6.000.000 minutos.' })
  @ApiResponse({ status: 404, description: 'Jogo inexistente, categoria diferente ou item de outra conta.' })
  @ApiResponse({ status: 403, description: 'Origem não permitida.' })
  async gameTime(@Req() request: Request, @Param('id') id: string, @Body() dto: GameTimeDto) { return { item: await this.catalog.localize(await this.library.gameTime(await this.owner(request), id, dto), await this.language(request)) }; }
  @ApiResponse({ status: 409, description: 'Status ou arquivamento alterado simultaneamente; atualize antes de reenviar.' })
  @Post(':id/archive') @HttpCode(200) async archive(@Req() request: Request, @Param('id') id: string, @Body() dto: ArchiveDto) { return { item: await this.catalog.localize(await this.library.archive(await this.owner(request), id, dto.archived), await this.language(request)) }; }
}
@Module({ imports: [AuthModule, CatalogModule, BooksModule, EpisodesModule, RewatchModule, MongooseModule.forFeature([{ name: LibraryItem.name, schema: ItemSchema }, { name: CatalogEntry.name, schema: CatalogSchema }, { name: TitleComment.name, schema: CommentSchema }])], controllers: [LibraryController], providers: [LibraryService, CommunityService], exports: [LibraryService] })
export class LibraryModule {}







