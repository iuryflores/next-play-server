import { recordSocialActivity } from '../social/social-store';
import { BadRequestException, ConflictException, Injectable, Module, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, Matches, Max, Min, ValidateIf } from 'class-validator';

export interface Viewing {
  id: string;
  startedAt: Date;
  completedAt?: Date;
  completedOn?: string | null;
  watchedDateUnknown?: boolean;
}
export class RewatchDto {
  @ApiProperty({ enum: ['plan', 'unplan', 'start', 'finish'], description: 'plan/unplan alteram a intenção; start abre outra visualização; finish encerra somente a visualização atual.' })
  @IsIn(['plan', 'unplan', 'start', 'finish']) action!: 'plan' | 'unplan' | 'start' | 'finish';
  @ApiProperty({ minimum: 0, maximum: 1000, description: 'Quantidade de novas visualizações vista pelo cliente. Impede criar ou encerrar outra visualização por reenvio/concorrência.' })
  @IsInt() @Min(0) @Max(1000) expectedCount!: number;
  @ApiProperty({ required: false, type: Boolean, description: 'No encerramento, consumo sem data. Incompatível com completedOn. Ausente usa hoje.' })
  @ValidateIf((_o, value) => value !== undefined) @IsBoolean() watchedDateUnknown?: boolean;
  @ApiProperty({ required: false, type: String, format: 'date', description: 'Data real do encerramento, válida e sem futuro. Não altera a primeira visualização.' })
  @ValidateIf((_o, value) => value !== undefined) @Matches(/^\d{4}-\d{2}-\d{2}$/) completedOn?: string;
}

// Cada repetição usa outro identificador de progresso. O item original permanece
// intacto e continua sendo a única fonte das contagens por título/episódio distinto.
export function viewingProgressId(item: { _id: Types.ObjectId; rewatchActiveId?: string | null }) {
  return item.rewatchActiveId ? new Types.ObjectId(item.rewatchActiveId) : item._id;
}
export function viewingCompletion(unknown = false, day?: string) {
  const now = new Date();
  if (unknown && day) throw new BadRequestException('Escolha uma data ou Não sei a data.');
  const completedOn = unknown ? null : day || now.toISOString().slice(0, 10);
  if (completedOn) {
    const parsed = new Date(completedOn + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== completedOn || completedOn > new Date(now.getTime() + 14 * 3600000).toISOString().slice(0, 10)) throw new BadRequestException('Informe uma data válida, sem ser no futuro.');
  }
  return { completedAt: now, completedOn, watchedDateUnknown: unknown };
}
export async function finishViewing(connection: Connection, item: { _id: Types.ObjectId; rewatchActiveId?: string | null }, unknown = false, day?: string) {
  const completion = viewingCompletion(unknown, day);
  const result = await connection.collection('library_items').updateOne({ _id: item._id, rewatchActiveId: item.rewatchActiveId, 'rewatches.id': item.rewatchActiveId }, {
    $set: { rewatchActiveId: null, rewatchWanted: false, updatedAt: new Date(), ...Object.fromEntries(Object.entries(completion).map(([key, value]) => ['rewatches.$.' + key, value])) },
  });
  if (!result.matchedCount) throw new ConflictException('A visualização mudou. Atualize e tente novamente.');
  await recordSocialActivity(connection, item._id, 'completed', `viewing:${item.rewatchActiveId}:completed`);
}

@Injectable()
export class RewatchService {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private async owned(owner: string, id: string) {
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestException('Título inválido.');
    const item = await this.connection.collection('library_items').findOne({ _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(owner) });
    if (!item) throw new NotFoundException('Título não encontrado.');
    if (!['movie', 'series'].includes(item.kind)) throw new BadRequestException('Reassistir disponível para filmes e séries.');
    return item;
  }
  async seriesFinished(item: { _id: Types.ObjectId; catalogId?: string; rewatchActiveId?: string | null }) {
    const seasons = await this.connection.collection('series_seasons').find({ catalogId: item.catalogId, number: { $gt: 0 } }).toArray();
    if (!seasons.length || seasons.some(season => !season.loaded)) return false;
    const today = new Date().toISOString().slice(0, 10);
    const required = seasons.flatMap(season => (season.episodes || []).filter((episode: { airDate?: string }) => !episode.airDate || episode.airDate <= today).map((episode: { number: number }) => season.number + ':' + episode.number));
    const seen = await this.connection.collection('episode_progress').find({ itemId: viewingProgressId(item) }, { projection: { season: 1, episode: 1 } }).toArray();
    const keys = new Set(seen.map(row => row.season + ':' + row.episode));
    return required.length > 0 && required.every(key => keys.has(key));
  }
  async change(owner: string, id: string, dto: RewatchDto) {
    const item = await this.owned(owner, id);
    const history: Viewing[] = item.rewatches || [];
    if (history.length !== dto.expectedCount) throw new ConflictException('O histórico mudou. Atualize e tente novamente.');
    if (dto.action !== 'finish' && (dto.completedOn !== undefined || dto.watchedDateUnknown !== undefined)) throw new BadRequestException('Data disponível somente ao concluir esta vez.');
    if (dto.action === 'finish') {
      if (!item.rewatchActiveId) throw new BadRequestException('Nenhuma visualização em andamento.');
      if (item.kind === 'series' && item.catalogId?.startsWith('tmdb:series:') && !await this.seriesFinished(item)) throw new BadRequestException('Conclua os episódios desta visualização antes de encerrá-la.');
      await finishViewing(this.connection, item, dto.watchedDateUnknown, dto.completedOn);
      return;
    }
    if (item.rewatchActiveId) throw new ConflictException('Já existe uma visualização em andamento.');
    if (item.archived) throw new BadRequestException('Restaure o título antes de reassistir.');
    if (item.status !== 'completed' && !(item.kind === 'series' && await this.seriesFinished(item))) throw new BadRequestException('Conclua a primeira visualização antes de reassistir.');
    if (dto.action === 'start' && history.length >= 1000) throw new BadRequestException('Limite de visualizações atingido.');
    const next = new Types.ObjectId().toString();
    const result = await this.connection.collection('library_items').updateOne({ _id: item._id, ownerId: item.ownerId, rewatchActiveId: { $in: [null] }, $expr: { $eq: [{ $size: { $ifNull: ['$rewatches', []] } }, dto.expectedCount] } }, dto.action === 'start' ? {
      $push: { rewatches: { id: next, startedAt: new Date() } } as never,
      $set: { rewatchActiveId: next, rewatchWanted: false, updatedAt: new Date() },
    } : { $set: { rewatchWanted: dto.action === 'plan', updatedAt: new Date() } });
    if (!result.matchedCount) throw new ConflictException('O acompanhamento mudou. Atualize e tente novamente.');
    if (dto.action === 'start') await recordSocialActivity(this.connection, item._id, 'started', `viewing:${next}:started`);
  }
  async history(owner: string, id: string, before?: number) {
    const item = await this.owned(owner, id);
    const cycles: Viewing[] = item.rewatches || [];
    // A primeira vez usa os registros reais existentes; não inventamos início ou data de consumo legada.
    const first = { id: item._id.toString(), number: 1, completedAt: item.completedAt, completedOn: item.completedOn, watchedDateUnknown: Boolean(item.watchedDateUnknown), original: true };
    const entries = [first, ...cycles.map((cycle, index) => ({ ...cycle, number: index + 2, original: false }))];
    const page = entries.filter(entry => before === undefined || entry.number < before).reverse().slice(0, 10);
    const progress = item.kind === 'series' ? await this.connection.collection('episode_progress').find({ itemId: { $in: page.map(entry => new Types.ObjectId(entry.id)) } }, { projection: { itemId: 1, season: 1, episode: 1, watchedAt: 1, watchedDateUnknown: 1 } }).sort({ season: 1, episode: 1 }).toArray() : [];
    return { nextBefore: page.length && page[page.length - 1].number > 1 ? page[page.length - 1].number : null, entries: page.map(entry => ({ ...entry, active: entry.id === item.rewatchActiveId, episodes: progress.filter(row => row.itemId.toString() === entry.id).map(row => ({ season: row.season, episode: row.episode, watchedAt: row.watchedAt || null, watchedDateUnknown: Boolean(row.watchedDateUnknown) })) })) };
  }
}
@Module({ providers: [RewatchService], exports: [RewatchService] })
export class RewatchModule {}
