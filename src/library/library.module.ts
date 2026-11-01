import { ApiProperty, ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { voteIdentity, emptyVoteIdentity } from './vote-identity';
import { snapshot } from './ranking-snapshot';
import { compareRankingVisit } from './ranking-visits';



import { actorVotes, type CastCache } from './actor-votes';
import { EpisodesModule, EpisodesService } from '../episodes/episodes.module';
import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, Query, Patch, Post, Req, ForbiddenException, BadRequestException, ConflictException, OnModuleInit } from '@nestjs/common';
import { CatalogModule, CatalogService } from '../catalog/catalog.module';
import { InjectConnection, InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Connection, Model, Schema as MongoSchema, Types, HydratedDocument } from 'mongoose';
import { createHash } from 'node:crypto';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, Min, Max, Matches, IsArray, ArrayMaxSize, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config';

const kinds = ['movie', 'series', 'game', 'book'];
const statuses = ['planned', 'active', 'completed'];
@Schema({ timestamps: true, collection: 'library_items' })
class LibraryItem {
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, index: true }) ownerId!: Types.ObjectId;
  @Prop({ required: true, maxlength: 200 }) title!: string;
  @Prop({ maxlength: 200 }) originalTitle?: string;
  @Prop({ required: true, enum: kinds }) kind!: string;
  @Prop({ required: true, enum: statuses }) status!: string;
  @Prop({ default: false }) archived!: boolean;
  @Prop({ default: '', maxlength: 1000 }) notes!: string;
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
  @Prop() catalogKey?: string;
  @Prop() catalogId?: string;
  @Prop() coverUrl?: string;
  @Prop() year?: string;
  @Prop({ type: [{ _id: false, id: Number, name: String, logoUrl: String }], default: undefined }) productionCompanies?: { id: number; name: string; logoUrl?: string | null }[];
  @Prop({ type: Number }) runtime?: number | null;
  @Prop() releaseDate?: string;
  @Prop() unreleased?: boolean;
  @Prop() overview?: string;
  @Prop() sourceUrl?: string;
}
const ItemSchema = SchemaFactory.createForClass(LibraryItem);
ItemSchema.index({ ownerId: 1, updatedAt: -1 });
ItemSchema.index({ ownerId: 1, catalogKey: 1 });
ItemSchema.index({ ownerId: 1, catalogId: 1 }, { unique: true, partialFilterExpression: { catalogId: { $type: 'string' } } });
@Schema({ timestamps: true, collection: 'catalog_titles' })
class CatalogEntry {
  @Prop({ required: true, unique: true }) key!: string;
  @Prop({ required: true }) title!: string;
  @Prop({ maxlength: 200 }) originalTitle?: string;
  @Prop({ required: true, enum: kinds }) kind!: string;
  @Prop({ type: [String], default: [] }) genres!: string[];
  @Prop() catalogId?: string;
  @Prop() coverUrl?: string;
  @Prop() year?: string;
  @Prop({ type: [{ _id: false, id: Number, name: String, logoUrl: String }], default: undefined }) productionCompanies?: { id: number; name: string; logoUrl?: string | null }[];
  @Prop({ type: Number }) runtime?: number | null;
  @Prop() releaseDate?: string;
  @Prop() unreleased?: boolean;
  @Prop() overview?: string;
  @Prop() sourceUrl?: string;
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
  @ApiProperty({ type: String, required: true, minLength: 1, maxLength: 2000 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
}
class ArchiveDto { @ApiProperty({ type: Boolean, required: true })
  @IsBoolean() archived!: boolean; }
class ItemDto {
  @ApiProperty({ type: String, required: true, minLength: 1, maxLength: 200 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @ApiProperty({ type: String, required: true, enum: kinds })
  @IsIn(kinds) kind!: string;
  @ApiProperty({ type: String, required: true, enum: statuses })
  @IsIn(statuses) status!: string;
  @ApiProperty({ type: String, required: false, maxLength: 1000 })
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiProperty({ type: [String], required: false, maxLength: 60, maxItems: 8 })
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(60, { each: true }) genres?: string[];
  @ApiProperty({ type: String, required: false, maxLength: 60 })
  @IsOptional() @IsString() @MaxLength(60) platform?: string;
  @ApiProperty({ type: String, required: false })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) completedOn?: string;
  @ApiProperty({ type: Number, required: false, minimum: 0, maximum: 5 })
  @IsOptional() @IsInt() @Min(0) @Max(5) stars?: number;
  @ApiProperty({ type: String, required: false, enum: ['', 'loved', 'liked', 'neutral', 'disliked', 'scared', 'happy', 'amused', 'sad', 'surprised', 'excited', 'moved', 'bored'] })
  @IsOptional() @IsIn(['', 'loved', 'liked', 'neutral', 'disliked', 'scared', 'happy', 'amused', 'sad', 'surprised', 'excited', 'moved', 'bored']) feeling?: string;
  @ApiProperty({ type: String, required: false, maxLength: 100 })
  @IsOptional() @IsString() @MaxLength(100) favoriteCharacter?: string;
  @ApiProperty({ type: String, required: false, maxLength: 500 })
  @IsOptional() @IsString() @MaxLength(500) favoriteCastId?: string;
  @ApiProperty({ type: String, required: false, maxLength: 60 })
  @IsOptional() @IsString() @MaxLength(60) catalogId?: string;
}
@Injectable()
export class LibraryService implements OnModuleInit {
  constructor(@InjectModel(LibraryItem.name) private readonly items: Model<LibraryItem>, private readonly catalog: CatalogService, @InjectModel(CatalogEntry.name) private readonly titles: Model<CatalogEntry>, @InjectModel(TitleComment.name) private readonly comments: Model<TitleComment>, @InjectConnection() private readonly connection: Connection, private readonly episodes: EpisodesService) {}
  async onModuleInit() {
    await Promise.all([this.items.init(), this.titles.init(), this.comments.init()]);
    // Backfill metadata already saved locally; never call providers at startup.
    for await (const item of this.items.find({ catalogKey: { $exists: false } }).cursor()) {
      const key = await this.remember(item);
      await this.items.updateOne({ _id: item._id, catalogKey: { $exists: false } }, { $set: { catalogKey: key } });
    }
  }
  private async completion(dto: ItemDto, previous?: LibraryItem, catalogId?: string) {
    if (dto.status !== 'completed') return { ...emptyVoteIdentity, completedOn: null, completedAt: null, stars: 0, feeling: '', favoriteCharacter: '' };
    const now = new Date();
    const completedOn = dto.completedOn || previous?.completedOn || now.toISOString().slice(0, 10);
    const date = new Date(completedOn + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== completedOn || completedOn > new Date(now.getTime() + 14 * 3600000).toISOString().slice(0, 10)) throw new BadRequestException('Informe uma data de conclusão válida, sem ser no futuro.');
    const name = (dto.favoriteCharacter ?? previous?.favoriteCharacter ?? '').trim();
    const identity = (!dto.favoriteCastId || dto.favoriteCastId === previous?.favoriteCastId) && name === previous?.favoriteCharacter && previous?.favoriteActorId
      ? { favoriteCastId: previous.favoriteCastId, favoriteActorId: previous.favoriteActorId, favoriteActorName: previous.favoriteActorName, favoriteActorPhoto: previous.favoriteActorPhoto }
      : await voteIdentity(this.connection, catalogId || previous?.catalogId, name, dto.favoriteCastId);
    return { ...identity, completedOn, completedAt: previous?.completedAt || now, stars: dto.stars ?? previous?.stars ?? 0, feeling: dto.feeling ?? previous?.feeling ?? '', favoriteCharacter: (dto.favoriteCharacter ?? previous?.favoriteCharacter ?? '').trim() };
  }
  private async owned(ownerId: string, id: string) {
    const item = await this.items.findOne({ _id: this.id(id), ownerId }).exec();
    if (!item) throw new NotFoundException('Item não encontrado.');
    return item;
  }
  async community(ownerId: string, id: string, before?: string) {
    const item = await this.owned(ownerId, id);
    const rows = await this.comments.find({ catalogKey: item.catalogKey, ...(before ? { _id: { $lt: this.id(before) } } : {}) }).sort({ _id: -1 }).limit(31).exec();
    const votes = await this.items.find({ catalogKey: item.catalogKey, status: 'completed', favoriteCharacter: { $nin: ['', null] } }).select('ownerId favoriteCharacter').lean().exec();
    const tallies = new Map<string, { name: string; owners: Set<string> }>();
    for (const vote of votes) {
      const name = vote.favoriteCharacter?.trim(); if (!name) continue;
      const key = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
      const tally = tallies.get(key) || { name, owners: new Set<string>() }; tally.owners.add(vote.ownerId.toString()); tallies.set(key, tally);
    }
    return { comments: rows.slice(0, 30).map(comment => ({ id: comment.id, text: comment.text, createdAt: comment.createdAt, mine: comment.ownerId.toString() === ownerId, author: 'Pessoa ' + createHash('sha256').update(comment.catalogKey + comment.ownerId.toString()).digest('hex').slice(0, 6) })), next: rows.length > 30 ? rows[29].id : null, votes: [...tallies.values()].map(tally => ({ name: tally.name, count: tally.owners.size })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 10) };
  }
  async cast(ownerId: string, id: string, language: string, season?: number, episode?: number) {
    const item = await this.owned(ownerId, id);
    this.catalog.limit(ownerId);
    return { cast: await this.catalog.cast(item.catalogId, language, season, episode) };
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
  async comment(ownerId: string, id: string, dto: CommentDto) {
    const item = await this.owned(ownerId, id);
    await this.comments.create({ ownerId, catalogKey: item.catalogKey, text: dto.text });
  }
  async deleteComment(ownerId: string, id: string, commentId: string) {
    const item = await this.owned(ownerId, id);
    const removed = await this.comments.findOneAndDelete({ _id: this.id(commentId), catalogKey: item.catalogKey, ownerId });
    if (!removed) throw new NotFoundException('Comentário não encontrado.');
  }
  private metadata(item: Partial<CatalogEntry>) {
    return { title: item.title, originalTitle: item.originalTitle, kind: item.kind, genres: item.genres || [], catalogId: item.catalogId, coverUrl: item.coverUrl, year: item.year, runtime: item.runtime, productionCompanies: item.productionCompanies, releaseDate: item.releaseDate, unreleased: item.unreleased, overview: item.overview, sourceUrl: item.sourceUrl };
  }
  private async remember(item: Partial<CatalogEntry>) {
    const key = item.catalogId || 'local:' + createHash('sha256').update(item.kind + ':' + item.title!.trim().toLocaleLowerCase('pt-BR')).digest('hex').slice(0, 40);
    try { await this.titles.updateOne({ key }, { $setOnInsert: { ...this.metadata(item), key } }, { upsert: true }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    return key;
  }
  async explore(ownerId: string, language = 'pt-BR', page = 1, selectedKind?: string) {
    if (!Number.isInteger(page) || page < 1 || page > 500 || selectedKind && !kinds.includes(selectedKind)) throw new BadRequestException('Página ou categoria inválida.');
    const owned = await this.items.find({ ownerId }).lean().exec();
    const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
    const sections = [];
    for (const kind of kinds.filter(kind => !selectedKind || kind === selectedKind)) {
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
          sections.push({ kind, nextPage: suggestions.nextPage, source: 'tmdb', personalized: weights.size > 0, genres: ranked.slice(0, 3).map(([genre]) => genre), results });
        } catch { sections.push({ kind, source: 'tmdb', personalized: weights.size > 0, genres: ranked.slice(0, 3).map(([genre]) => genre), results: [], unavailable: true }); }
        continue;
      }
      const candidates = await this.titles.find({ kind, key: { $nin: ownedKeys } }).lean().exec();
      const results = candidates.filter(item => !ownedNames.has(normalize(item.title))).map(item => {
        const matches = [...new Map((item.genres || []).filter(genre => weights.has(normalize(genre))).map(genre => [normalize(genre), genre])).values()];
        return { ...this.metadata(item), catalogId: item.key, inCollection: ownedNames.has(normalize(item.title)), matches, score: matches.reduce((sum, genre) => sum + (weights.get(normalize(genre)) || 0), 0) };
      }).filter(item => !weights.size || item.score > 0).sort((a, b) => Number(a.inCollection) - Number(b.inCollection) || b.score - a.score || a.title!.localeCompare(b.title!)).slice((page - 1) * 12, page * 12 + 1).map(({ score, ...item }) => ({ ...item, relevance: score }));
      sections.push({ kind, nextPage: results.length > 12 && page < 500 ? page + 1 : null, personalized: weights.size > 0, genres: ranked.slice(0, 3).map(([genre]) => genre), results: results.slice(0, 12) });
    }
    return { sections };
  }
  private publicItem(item: HydratedDocument<LibraryItem> & { updatedAt?: Date }) { return { lastWatchedAt: ['movie', 'series'].includes(item.kind) && item.status === 'completed' ? (item.completedOn && item.completedOn !== item.completedAt?.toISOString().slice(0, 10) ? new Date(item.completedOn + 'T00:00:00Z') : item.completedAt) : undefined, id: item._id.toString(), platform: item.kind === 'game' ? item.platform || '' : undefined, title: item.title, originalTitle: item.originalTitle, kind: item.kind, status: item.kind === 'movie' && item.status === 'active' ? 'planned' : item.status, archived: Boolean(item.archived), completedOn: item.completedOn, completedAt: item.completedAt, episodesCompletedAt: item.episodesCompletedAt, stars: item.stars || 0, feeling: item.feeling || '', favoriteCharacter: item.favoriteCharacter || '', favoriteCastId: item.favoriteCastId || '', notes: item.notes, updatedAt: item.updatedAt, genres: item.genres || [], catalogId: item.catalogId, coverUrl: item.coverUrl, year: item.year, runtime: item.runtime, productionCompanies: item.productionCompanies, releaseDate: item.releaseDate, unreleased: item.unreleased, overview: item.overview, sourceUrl: item.sourceUrl }; }
  private id(value: string) { if (!/^[a-f0-9]{24}$/i.test(value)) throw new BadRequestException('Item inválido.'); return value; }
  async list(ownerId: string) {
    const items = await this.items.find({ ownerId }).sort({ updatedAt: -1, _id: -1 }).exec();
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
    const series = items.filter(item => item.kind === 'series' && item.catalogId?.startsWith('tmdb:series:'));
    if (!series.length) return items.map(item => this.publicItem(item));
    const [seasons, progress] = await Promise.all([
      this.connection.collection('series_seasons').find({ catalogId: { $in: series.map(item => item.catalogId) }, number: { $gt: 0 } }, { projection: { catalogId: 1, number: 1, loaded: 1, total: 1, 'episodes.number': 1, 'episodes.name': 1, 'episodes.airDate': 1 } }).sort({ number: 1 }).toArray(),
      this.connection.collection('episode_progress').find({ itemId: { $in: series.map(item => item._id) }, season: { $gt: 0 } }, { projection: { itemId: 1, season: 1, episode: 1, watchedAt: 1 } }).toArray(),
    ]);
    return items.map(item => {
      if (!series.some(value => value.id === item.id)) return this.publicItem(item);
      const available = seasons.filter(season => season.catalogId === item.catalogId);
      const latest = progress.filter(row => row.itemId.toString() === item.id && row.watchedAt).sort((a, b) => new Date(b.watchedAt).getTime() - new Date(a.watchedAt).getTime() || b.season - a.season || b.episode - a.episode)[0];
      const base = this.publicItem(item);
      const lastWatchedAt = latest && (!base.lastWatchedAt || new Date(latest.watchedAt) >= new Date(base.lastWatchedAt)) ? latest.watchedAt : base.lastWatchedAt;
      const watched = new Set(progress.filter(row => row.itemId.toString() === item.id).map(row => row.season + ':' + row.episode));
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
      return { ...base, caughtUp, lastWatchedAt, lastWatchedEpisode: latest ? { season: latest.season, episode: latest.episode } : undefined, status: item.status === 'completed' ? 'completed' : watched.size > 0 ? 'active' : 'planned', inProgress: item.status !== 'completed' && watched.size > 0 && !caughtUp, episodeProgress: { next, watched: count, total: available.reduce((sum, season) => sum + (season.loaded ? (season.episodes || []).filter((episode: { airDate?: string }) => !episode.airDate || episode.airDate <= new Date().toISOString().slice(0, 10)).length : season.total || 0), 0), initialized: available.length > 0 } };
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
    const items = await this.items.find({ ownerId }).lean().exec();
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
    const details = stored ? this.metadata(stored) : catalogId ? await this.catalog.detail(catalogId) : undefined;
    if (details && details.kind !== dto.kind) throw new BadRequestException('A categoria não corresponde ao título selecionado.');
    const payload = { ...manual, ...details, genres: [...new Set((dto.kind === 'game' ? dto.genres ?? details?.genres ?? [] : details?.genres ?? manual.genres ?? []).map(value => value.trim()).filter(Boolean))], platform: dto.kind === 'game' ? (dto.platform || '').trim() : '' };
    const completion = await this.completion(dto, undefined, catalogId);
    const allEpisodes = dto.status === 'completed' && payload.kind === 'series' && details?.catalogId?.startsWith('tmdb:series:') ? await this.episodes.prepareCompletion(details.catalogId!) : null;
    const catalogKey = await this.remember(payload);
    if (await this.items.exists({ ownerId, catalogKey })) throw new ConflictException('Este título já está na sua coleção.');
    try { const item = await this.items.create({ ...payload, ...completion, catalogKey, ownerId }); if (allEpisodes) { await this.episodes.markComplete(item._id, allEpisodes, item.completedAt || new Date()); item.episodesCompletedAt = new Date(); } return this.publicItem(item); }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new ConflictException('Este título já está na sua coleção.'); throw error; }
  }
  async update(ownerId: string, id: string, dto: ItemDto) {
    const existing = await this.items.findOne({ _id: this.id(id), ownerId }).exec();
    if (!existing) throw new NotFoundException('Item não encontrado.');
    if ((existing.catalogId ? existing.kind : dto.kind) === 'movie' && dto.status === 'active') dto.status = 'planned';
    if (dto.catalogId && dto.catalogId !== existing.catalogId) throw new BadRequestException('Não é possível trocar a referência deste título.');
    const allEpisodes = dto.status === 'completed' && existing.kind === 'series' && existing.catalogId?.startsWith('tmdb:series:') && (existing.status !== 'completed' || !existing.episodesCompletedAt) ? await this.episodes.prepareCompletion(existing.catalogId) : null;
    const changes = existing.catalogId ? { status: dto.status, notes: dto.notes ?? '', genres: dto.genres ?? existing.genres } : { title: dto.title, kind: dto.kind, status: dto.status, notes: dto.notes ?? '', genres: dto.genres ?? existing.genres };
    const item = await this.items.findOneAndUpdate({ _id: this.id(id), ownerId }, { $set: { ...changes, platform: (existing.catalogId ? existing.kind : dto.kind) === 'game' ? (dto.platform ?? existing.platform ?? '').trim() : '', ...await this.completion(dto, existing) } }, { returnDocument: 'after', runValidators: true }).exec();
    if (!item) throw new NotFoundException('Item não encontrado.');
    if (allEpisodes) { await this.episodes.markComplete(item._id, allEpisodes, item.completedAt || new Date()); item.episodesCompletedAt = new Date(); }
    const key = await this.remember(item);
    await this.titles.updateOne({ key }, { $set: this.metadata(item) });
    if (item.catalogKey !== key) { item.catalogKey = key; await item.save(); }
    return this.publicItem(item);
  }
  async archive(ownerId: string, id: string, archived: boolean) {
    const item = await this.items.findOneAndUpdate({ _id: this.id(id), ownerId }, { $set: { archived } }, { returnDocument: 'after', runValidators: true }).exec();
    if (!item) throw new NotFoundException('Item não encontrado.');
    return this.publicItem(item);
  }
  async remove(ownerId: string, id: string) {
 
    const item = await this.items.findOneAndDelete({ _id: this.id(id), ownerId }).exec();
    if (!item) throw new NotFoundException('Item não encontrado.');
  }
}
@ApiTags('library')
@ApiCookieAuth('session')
@Controller('library')
class LibraryController {
  constructor(private readonly library: LibraryService, private readonly auth: AuthService, private readonly catalog: CatalogService) {}
  private async language(request: Request) { const token: unknown = request.cookies?.[getConfig().cookieName]; return (await this.auth.me(typeof token === 'string' ? token : undefined)).language; }
  private async owner(request: Request) {
    if (request.method !== 'GET' && request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem da requisição não permitida.');
    const token: unknown = request.cookies?.[getConfig().cookieName];
    return (await this.auth.me(typeof token === 'string' ? token : undefined)).id;
  }
  @Get(':id/community') async community(@Req() request: Request, @Param('id') id: string, @Query('before') before?: string) { return this.library.community(await this.owner(request), id, before); }
  @Get(':id/cast') async cast(@Req() request: Request, @Param('id') id: string, @Query('season') season?: string, @Query('episode') episode?: string) { return this.library.cast(await this.owner(request), id, await this.language(request), season === undefined ? undefined : Number(season), episode === undefined ? undefined : Number(episode)); }
  @Post(':id/comments') @HttpCode(204) async comment(@Req() request: Request, @Param('id') id: string, @Body() dto: CommentDto) { await this.library.comment(await this.owner(request), id, dto); }
  @Delete(':id/comments/:commentId') @HttpCode(204) async deleteComment(@Req() request: Request, @Param('id') id: string, @Param('commentId') commentId: string) { await this.library.deleteComment(await this.owner(request), id, commentId); }
  @Get(':id/upcoming') async upcoming(@Req() request: Request, @Param('id') id: string) { return this.library.upcoming(await this.owner(request), id, await this.language(request)); }
  @Get(':id/directors') async directors(@Req() request: Request, @Param('id') id: string) { return this.library.directors(await this.owner(request), id); }
  @Get(':id/trailer') async trailer(@Req() request: Request, @Param('id') id: string) { return this.library.trailer(await this.owner(request), id, await this.language(request)); }
  @Post(':id/production-companies') async movieCompanies(@Req() request: Request, @Param('id') id: string) { return this.library.movieCompanies(await this.owner(request), id); }
  @Post(':id/runtime') async movieRuntime(@Req() request: Request, @Param('id') id: string) { return this.library.movieRuntime(await this.owner(request), id); }
  @Get('stats') async stats(@Req() request: Request) { const owner = await this.owner(request); return this.library.rankingVisit(owner, request.get('X-Ranking-Visit')); }
  @Get('explore') async explore(@Req() request: Request, @Query('page') page?: string, @Query('kind') kind?: string) { const owner = await this.owner(request); const language = await this.language(request); this.catalog.limit(owner); const result = await this.library.explore(owner, language, page === undefined ? 1 : Number(page), kind); return { sections: await Promise.all(result.sections.map(async section => ({ ...section, results: 'source' in section && section.source === 'tmdb' ? section.results : await Promise.all(section.results.map(item => this.catalog.localize(item, language))) }))) }; }
  @Get() async list(@Req() request: Request) { return { items: await this.catalog.localizeMany(await this.library.list(await this.owner(request)), await this.language(request)) }; }
  @Post() async create(@Req() request: Request, @Body() dto: ItemDto) { return { item: await this.catalog.localize(await this.library.create(await this.owner(request), dto), await this.language(request)) }; }
  @Patch(':id') async update(@Req() request: Request, @Param('id') id: string, @Body() dto: ItemDto) { return { item: await this.catalog.localize(await this.library.update(await this.owner(request), id, dto), await this.language(request)) }; }
  @Delete(':id') @HttpCode(204) async remove(@Req() request: Request, @Param('id') id: string) { await this.library.remove(await this.owner(request), id); }
  @Post(':id/archive') @HttpCode(200) async archive(@Req() request: Request, @Param('id') id: string, @Body() dto: ArchiveDto) { return { item: await this.catalog.localize(await this.library.archive(await this.owner(request), id, dto.archived), await this.language(request)) }; }
}
@Module({ imports: [AuthModule, CatalogModule, EpisodesModule, MongooseModule.forFeature([{ name: LibraryItem.name, schema: ItemSchema }, { name: CatalogEntry.name, schema: CatalogSchema }, { name: TitleComment.name, schema: CommentSchema }])], controllers: [LibraryController], providers: [LibraryService], exports: [LibraryService] })
export class LibraryModule {}







