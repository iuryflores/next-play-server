import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, OnModuleInit, Param, Post, Query, Req } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config';

type Evidence = { title: string; completedOn: string };
type Progress = { count: number; evidence: Evidence[] };
type Challenge = { _id: string; ownerId: Types.ObjectId; name: string; kind: 'game' | 'movie' | 'book'; platform?: string; target: number; startsOn: string; endsOn: string; timeZone: string; signature: string; createdAt: Date; closedAt?: Date; snapshot?: Progress };
type Completion = { platform?: string; kind: string; title: string; catalogId?: string; catalogKey?: string; year?: string; parentGameCatalogId?: string; watchedDateUnknown?: boolean; completedOn?: string };
class CreateChallengeDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Chave idempotente do desafio, gerada pelo cliente.' }) @IsUUID() id!: string;
  @ApiProperty({ minLength: 3, maxLength: 100 }) @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(3) @MaxLength(100) name!: string;
  @ApiProperty({ enum: ['game', 'movie', 'book'], description: 'Títulos distintos concluídos no período. Jogos excluem DLCs/expansões dependentes identificados; expansões independentes contam.' }) @IsIn(['game', 'movie', 'book']) kind!: Challenge['kind'];
  @ApiProperty({ type: String, required: false, maxLength: 60, description: 'Somente jogos: plataforma do acompanhamento. Ausente ou vazia inclui todas. Compara grafia normalizada (espaços, acentos e caixa), mantendo consoles diferentes separados.' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value) @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(60) platform?: string;
  @ApiProperty({ minimum: 1, maximum: 10000 }) @IsInt() @Min(1) @Max(10000) target!: number;
  @ApiProperty({ format: 'date' }) @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) startsOn!: string;
  @ApiProperty({ format: 'date', description: 'Inclusiva, igual ou posterior ao início.' }) @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) endsOn!: string;
  @ApiProperty({ maxLength: 100, example: 'America/Sao_Paulo', description: 'Fuso usado para determinar o dia atual e o prazo.' }) @IsString() @MaxLength(100) timeZone!: string;
}
class ChallengeQuery { @ApiProperty({ required: false, format: 'uuid' }) @IsOptional() @IsUUID() before?: string; }
export function validChallengeDate(value: string) { const date = new Date(value + 'T00:00:00Z'); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }
export function challengePlatformKey(value?: string) {
  // Compatível com os filtros da biblioteca: PS4/PS5 e nomes personalizados não viram uma família única.
  return (value || '').trim().replace(/\s+/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}
export function challengeProgress(challenge: Pick<Challenge, 'kind' | 'startsOn' | 'endsOn' | 'platform'>, items: Completion[], dependentIds: Set<string>, today: string): Progress {
  const distinct = new Map<string, Completion>();
  for (const item of items) {
    // Ausência de data não é hoje. Arquivados contam; posse e horas não comprovam conclusão.
    if (item.kind !== challenge.kind || item.watchedDateUnknown || !item.completedOn || !validChallengeDate(item.completedOn) || item.completedOn < challenge.startsOn || item.completedOn > challenge.endsOn || item.completedOn > today) continue;
    if (challenge.platform && challengePlatformKey(item.platform) !== challengePlatformKey(challenge.platform)) continue;
    if (item.kind === 'game' && (item.parentGameCatalogId || (item.catalogId && dependentIds.has(item.catalogId)))) continue;
    const fallback = `${item.title.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')}:${item.year || ''}`;
    const key = item.catalogId || item.catalogKey || fallback;
    const previous = distinct.get(key);
    if (!previous || item.completedOn > previous.completedOn!) distinct.set(key, item);
  }
  const rows = [...distinct.values()].sort((a, b) => b.completedOn!.localeCompare(a.completedOn!) || a.title.localeCompare(b.title));
  return { count: rows.length, evidence: rows.slice(0, 5).map(item => ({ title: item.title, completedOn: item.completedOn! })) };
}
function todayIn(timeZone: string) {
  try { const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)!.value).join('-'); }
  catch { throw new BadRequestException('Fuso horário inválido.'); }
}
@Injectable()
export class ChallengesService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private challenges() { return this.connection.collection<Challenge>('personal_challenges'); }
  async onModuleInit() { await this.challenges().createIndex({ ownerId: 1, createdAt: -1, _id: -1 }); }
  private async owned(owner: string, id: string) { const row = await this.challenges().findOne({ _id: id, ownerId: new Types.ObjectId(owner) }); if (!row) throw new NotFoundException('Desafio não encontrado.'); return row; }
  private async completions(owner: string) {
    const items = await this.connection.collection<Completion>('library_items').find({ ownerId: new Types.ObjectId(owner), status: 'completed', kind: { $in: ['game', 'movie', 'book'] } }, { projection: { kind: 1, title: 1, catalogId: 1, catalogKey: 1, year: 1, platform: 1, completedOn: 1, watchedDateUnknown: 1, parentGameCatalogId: 1 } }).toArray();
    const gameIds = items.flatMap(item => item.kind === 'game' && /^igdb:game:[1-9]\d*$/.test(item.catalogId || '') ? [Number(item.catalogId!.split(':')[2])] : []);
    const directories = gameIds.length ? await this.connection.collection<{ refs: { id: number; contentType: string }[] }>('catalog_game_addons').find({ 'refs.id': { $in: gameIds } }, { projection: { refs: 1 } }).toArray() : [];
    return { items, dependent: new Set(directories.flatMap(row => row.refs.filter(ref => ref.contentType !== 'standalone-expansion').map(ref => `igdb:game:${ref.id}`))) };
  }
  private view(row: Challenge, progress: Progress) { const today = todayIn(row.timeZone); return { id: row._id, name: row.name, kind: row.kind, platform: row.platform || null, target: row.target, startsOn: row.startsOn, endsOn: row.endsOn, timeZone: row.timeZone, createdAt: row.createdAt, closedAt: row.closedAt || null, phase: row.closedAt ? 'closed' : today < row.startsOn ? 'scheduled' : today > row.endsOn ? 'ended' : 'active', count: progress.count, achieved: progress.count >= row.target, percent: Math.min(100, Math.floor(progress.count / row.target * 100)), evidence: progress.evidence }; }
  async list(owner: string, before?: string) {
    const cursor = before ? await this.owned(owner, before) : null;
    const rows = await this.challenges().find({ ownerId: new Types.ObjectId(owner), ...(cursor ? { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }] } : {}) }).sort({ createdAt: -1, _id: -1 }).limit(21).toArray();
    const visible = rows.slice(0, 20);
    const source = visible.some(row => !row.closedAt) ? await this.completions(owner) : { items: [], dependent: new Set<string>() };
    return { challenges: visible.map(row => this.view(row, row.closedAt && row.snapshot ? row.snapshot : challengeProgress(row, source.items, source.dependent, todayIn(row.timeZone)))), nextBefore: rows.length > 20 ? visible.at(-1)!._id : null };
  }
  async create(owner: string, dto: CreateChallengeDto) {
    if (!validChallengeDate(dto.startsOn) || !validChallengeDate(dto.endsOn) || dto.endsOn < dto.startsOn) throw new BadRequestException('Informe um período válido, com término igual ou posterior ao início.');
    todayIn(dto.timeZone);
    const platform = dto.platform?.trim().replace(/\s+/g, ' ') || undefined;
    if (platform && dto.kind !== 'game') throw new BadRequestException('A meta por plataforma está disponível somente para jogos.');
    const signature = JSON.stringify([dto.name, dto.kind, dto.target, dto.startsOn, dto.endsOn, dto.timeZone, ...(platform ? [challengePlatformKey(platform)] : [])]);
    const row: Challenge = { _id: dto.id, ownerId: new Types.ObjectId(owner), name: dto.name, kind: dto.kind, ...(platform ? { platform } : {}), target: dto.target, startsOn: dto.startsOn, endsOn: dto.endsOn, timeZone: dto.timeZone, signature, createdAt: new Date() };
    try { await this.challenges().insertOne(row); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; const existing = await this.challenges().findOne({ _id: dto.id, ownerId: row.ownerId }); if (!existing || existing.signature !== signature) throw new ConflictException('Esta chave de desafio já foi usada.'); return { id: existing._id }; }
    return { id: row._id };
  }
  async close(owner: string, id: string) {
    const row = await this.owned(owner, id);
    if (row.closedAt) return;
    const source = await this.completions(owner);
    const snapshot = challengeProgress(row, source.items, source.dependent, todayIn(row.timeZone));
    // O encerramento congela a contagem e as cinco evidências recentes, sem alterar títulos ou conceder XP.
    await this.challenges().updateOne({ _id: id, ownerId: row.ownerId, closedAt: { $exists: false } }, { $set: { closedAt: new Date(), snapshot } });
  }
  async remove(owner: string, id: string) { const result = await this.challenges().deleteOne({ _id: id, ownerId: new Types.ObjectId(owner) }); if (!result.deletedCount) throw new NotFoundException('Desafio não encontrado.'); }
}
@ApiTags('challenges') @ApiCookieAuth('session')
@ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
@Controller('challenges')
class ChallengesController {
  constructor(private readonly service: ChallengesService, private readonly auth: AuthService) {}
  private async owner(request: Request) { if (request.method !== 'GET' && request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem não permitida.'); return (await this.auth.forRequest(request)).id; }
  @Get() @ApiOperation({ summary: 'Consultar desafios pessoais e progresso', description: 'Privado. Até 20 desafios por página, ordenados por criação. Jogos principais e expansões independentes, filmes ou livros concluídos distintos no período inclusivo. Usa somente completedOn válido, excluindo data desconhecida e DLCs dependentes identificados. Plataforma opcional em jogos restringe às conclusões nela, sem agrupar consoles diferentes. Desafios antigos sem plataforma continuam contando todas. Arquivados contam; posse não conta. Atualiza com os dados atuais até encerrar; encerrados preservam snapshot. Nenhum XP ou conquista automática.' })
  @ApiOkResponse({ description: 'challenges: id, name, kind, platform nullable, target, startsOn, endsOn, timeZone, createdAt, closedAt nullable, phase (scheduled/active/ended/closed), count, achieved, percent e evidence (até cinco últimas conclusões com title/completedOn). nextBefore UUID ou null.' })
  async list(@Req() request: Request, @Query() query: ChallengeQuery) { return this.service.list(await this.owner(request), query.before); }
  @Post() @ApiOperation({ summary: 'Criar desafio pessoal', description: 'id UUID torna reenvios idempotentes. Período e meta definidos pelo dono; permite períodos passados e futuros. platform é opcional, exclusiva de jogos; vazio inclui todas. A plataforma é persistida e participa da idempotência; ao encerrar, o progresso filtrado também é congelado. Não altera títulos, XP ou conquistas.' }) @ApiResponse({ status: 201, description: 'Objeto id do desafio.' }) @ApiResponse({ status: 400, description: 'Nome, meta, tipo, datas ou fuso inválidos.' }) @ApiResponse({ status: 409, description: 'Chave já usada com outros dados.' })
  async create(@Req() request: Request, @Body() dto: CreateChallengeDto) { return this.service.create(await this.owner(request), dto); }
  @Post(':id/close') @HttpCode(204) @ApiOperation({ summary: 'Encerrar desafio e congelar o progresso atual', description: 'Idempotente. Congela contagem e cinco conclusões recentes. Não pode ser reaberto; não altera acompanhamentos.' }) @ApiResponse({ status: 204, description: 'Encerrado.' }) @ApiResponse({ status: 404, description: 'Desafio inexistente ou de outra conta.' })
  async close(@Req() request: Request, @Param('id') id: string) { await this.service.close(await this.owner(request), id); }
  @Delete(':id') @HttpCode(204) @ApiOperation({ summary: 'Excluir desafio pessoal', description: 'Exclui somente o desafio, preservando títulos e seus históricos.' }) @ApiResponse({ status: 204, description: 'Excluído.' }) @ApiResponse({ status: 404, description: 'Desafio inexistente ou de outra conta.' })
  async remove(@Req() request: Request, @Param('id') id: string) { await this.service.remove(await this.owner(request), id); }
}
@Module({ imports: [AuthModule], controllers: [ChallengesController], providers: [ChallengesService] })
export class ChallengesModule {}
