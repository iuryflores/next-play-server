import { BadRequestException, CallHandler, ExecutionContext, NestInterceptor, OnModuleDestroy, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, OnModuleInit, Post, Query, Req } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiQuery, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Connection, Types } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { mergeMap } from 'rxjs';
import { markXpDirty, XP_RULES_VERSION, XpJob } from './progression-queue';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { achievements } from '../achievements/achievement-rules';
import { getConfig } from '../config';
import { levelFromXp, xpCandidates, xpRules, XpKind, XpItem, XpEpisode } from './progression-rules';

type Credit = { _id: string; ownerId: Types.ObjectId; kind: XpKind; label: string; units: number; rate: number; firstRecordedAt: Date; updatedAt: Date };
class XpBreakdownDto {
  @ApiProperty({ enum: Object.keys(xpRules) }) kind!: string;
  @ApiProperty() label!: string;
  @ApiProperty() rate!: number;
  @ApiProperty() units!: number;
  @ApiProperty() xp!: number;
}
class XpRecentDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: Object.keys(xpRules) }) kind!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: 'XP acumulado desta atividade, incluindo aumentos anteriores de horas.' }) xp!: number;
  @ApiProperty({ format: 'date-time', description: 'Quando o sistema registrou o último aumento de XP; não é a data de consumo. Importações antigas recebem a data da sincronização.' }) recordedAt!: string;
}
class ProgressionDto {
  @ApiProperty({ minimum: 1 }) level!: number;
  @ApiProperty({ minimum: 0 }) totalXp!: number;
  @ApiProperty({ description: 'XP obtido dentro do nível atual.' }) currentXp!: number;
  @ApiProperty({ description: 'XP necessário para avançar neste nível: 100 + 25*(level-1).' }) requiredXp!: number;
  @ApiProperty({ type: [XpBreakdownDto] }) breakdown!: XpBreakdownDto[];
  @ApiProperty({ type: [XpRecentDto], description: 'Até 20 atividades com crédito mais recente. Datas refletem o registro no XP, inclusive importações.' }) recent!: XpRecentDto[];
  @ApiProperty({ example: 100 }) gameHourCap!: number;
}
@Injectable()
export class ProgressionService implements OnModuleInit, OnModuleDestroy {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private credits() { return this.connection.collection<Credit>('user_xp_credits'); }
  private jobs() { return this.connection.collection<XpJob>('user_xp_sync'); }
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private bootstrapAfter?: Types.ObjectId;
  private bootstrapDone = false;
  private inFlight = new Map<string, Promise<void>>();
  async onModuleInit() {
    await Promise.all([
      this.credits().createIndex({ ownerId: 1, updatedAt: -1, _id: 1 }),
      this.jobs().createIndex({ dirty: 1, leaseUntil: 1 }),
      this.jobs().createIndex({ version: 1 }),
    ]);
    await this.jobs().updateMany({ version: { $lt: XP_RULES_VERSION } }, { $set: { dirty: true } });
    this.armWorker();
  }
  onModuleDestroy() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
  private armWorker() {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick().catch(() => console.warn('[XP] Atualização pendente será repetida.')).finally(() => this.armWorker()); }, 1000);
    this.timer.unref();
  }
  private async tick() {
    // Migra contas antigas em lotes pequenos, fora das requisições e sem reler históricos já atualizados.
    if (!this.bootstrapDone) {
      const users = await this.connection.collection('users').find(this.bootstrapAfter ? { _id: { $gt: this.bootstrapAfter } } : {}, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(100).toArray();
      if (users.length) {
        await this.jobs().bulkWrite(users.map(user => ({ updateOne: { filter: { _id: user._id }, update: { $setOnInsert: { revision: 1, dirty: true, version: 0, leaseUntil: new Date(0) } }, upsert: true } })), { ordered: false });
        this.bootstrapAfter = users.at(-1)!._id;
      }
      this.bootstrapDone = users.length === 100 ? false : true;
    }
    const job = await this.jobs().findOneAndUpdate({ dirty: true, leaseUntil: { $lte: new Date() } }, { $set: { leaseUntil: new Date(Date.now() + 120000), leaseToken: randomUUID() } }, { returnDocument: 'after' });
    if (job) await this.runJob(job);
  }
  private async runJob(job: XpJob) {
    const owner = job._id.toString();
    const work = (async () => {
      try {
        await this.recognize(owner);
        // Confirma somente a revisão lida: um salvamento concorrente continua pendente.
        await this.jobs().updateOne({ _id: job._id, revision: job.revision, leaseToken: job.leaseToken }, { $set: { dirty: false, version: XP_RULES_VERSION, syncedAt: new Date() } });
        await this.jobs().updateOne({ _id: job._id, leaseToken: job.leaseToken }, { $set: { leaseUntil: new Date(0) }, $unset: { leaseToken: '' } });
      } catch (error) {
        await this.jobs().updateOne({ _id: job._id, leaseToken: job.leaseToken }, { $set: { leaseUntil: new Date(Date.now() + 10000) }, $unset: { leaseToken: '' } });
        throw error;
      }
    })();
    this.inFlight.set(owner, work);
    try { await work; } finally { if (this.inFlight.get(owner) === work) this.inFlight.delete(owner); }
  }
  async sync(owner: string, onlyIfDirty = false) {
    if (!onlyIfDirty) await markXpDirty(this.connection, owner);
    const pending = this.inFlight.get(owner);
    if (pending) await pending;
    else {
      const id = new Types.ObjectId(owner);
      if (!await this.jobs().findOne({ _id: id }, { projection: { _id: 1 } })) await markXpDirty(this.connection, owner);
      const job = await this.jobs().findOneAndUpdate({ _id: id, dirty: true, leaseUntil: { $lte: new Date() } }, { $set: { leaseUntil: new Date(Date.now() + 120000), leaseToken: randomUUID() } }, { returnDocument: 'after' });
      if (job) await this.runJob(job);
      else if (this.inFlight.has(owner)) await this.inFlight.get(owner);
    }
    return this.state(owner);
  }
  async recognize(owner: string) {
    const ownerId = new Types.ObjectId(owner);
    const items = await this.connection.collection<XpItem & { ownerId: Types.ObjectId }>('library_items').find({ ownerId }, { projection: { kind: 1, status: 1, title: 1, catalogId: 1, catalogKey: 1, year: 1, stars: 1, feeling: 1, playtimeMinutes: 1, runtime: 1, rewatches: 1 } }).toArray();
    const seriesIds = items.filter(item => item.kind === 'series').map(item => item._id);
    const [episodes, awards] = await Promise.all([
      seriesIds.length ? this.connection.collection<XpEpisode>('episode_progress').find({ itemId: { $in: seriesIds }, season: { $gt: 0 } }, { projection: { itemId: 1, season: 1, episode: 1, watchedAt: 1, watchedDateUnknown: 1, stars: 1, feeling: 1 } }).toArray() : [],
      this.connection.collection('achievement_awards').find({ ownerId }, { projection: { key: 1 } }).toArray(),
    ]);
    // Usa somente durações já conhecidas no cache local, sem consultar provedores ao abrir o nível/ranking.
    const catalogs = [...new Set(items.filter(item => item.kind === 'series' && item.catalogId).map(item => item.catalogId!))];
    const seasons = catalogs.length ? await this.connection.collection<{ catalogId: string; number: number; episodes?: { number: number; runtime?: number | null }[] }>('series_seasons').find({ catalogId: { $in: catalogs }, number: { $gt: 0 } }, { projection: { catalogId: 1, number: 1, 'episodes.number': 1, 'episodes.runtime': 1 } }).toArray() : [];
    const runtimes = new Map(seasons.flatMap(season => (season.episodes || []).map(episode => [`${season.catalogId}:${season.number}:${episode.number}`, episode.runtime] as const)));
    const seriesCatalogs = new Map(items.filter(item => item.kind === 'series').map(item => [String(item._id), item.catalogId]));
    const episodesWithRuntime = episodes.map(episode => ({ ...episode, runtime: runtimes.get(`${seriesCatalogs.get(episode.itemId.toString())}:${episode.season}:${episode.episode}`) }));
    const existing = await this.credits().find({ ownerId }, { projection: { units: 1 } }).toArray();
    const unitsById = new Map(existing.map(row => [row._id, row.units]));
    const creditId = (key: string) => `${owner}:${createHash('sha256').update(key).digest('hex')}`;
    // Leituras frequentes do ranking não regravam todo o histórico já reconhecido.
    const candidates = xpCandidates(items, episodesWithRuntime, awards.flatMap(row => {
      const definition = achievements.find(item => item.id === row.key);
      return definition ? [{ key: row.key, name: definition.name }] : [];
    })).filter(item => item.units > (unitsById.get(creditId(item.key)) || 0));
    // O identificador deriva da obra/episódio, não do registro removível da biblioteca.
    // O máximo persistido impede ganhar XP ao editar, desmarcar ou recadastrar a mesma obra.
    for (let offset = 0; offset < candidates.length; offset += 500) {
      const operations = candidates.slice(offset, offset + 500).map(item => ({ updateOne: {
        filter: { _id: creditId(item.key), ownerId },
        update: [{ $set: {
          ownerId: { $literal: ownerId }, kind: { $literal: item.kind },
          label: { $ifNull: ['$label', { $literal: item.label }] },
          rate: xpRules[item.kind].rate,
          firstRecordedAt: { $ifNull: ['$firstRecordedAt', '$$NOW'] },
          updatedAt: { $cond: [{ $gt: [item.units, { $ifNull: ['$units', 0] }] }, '$$NOW', '$updatedAt'] },
          units: { $max: [item.units, { $ifNull: ['$units', 0] }] },
        } }], upsert: true,
      } }));
      try { await this.credits().bulkWrite(operations, { ordered: false }); }
      catch (error) {
        const errors = (error as { writeErrors?: { code: number }[] }).writeErrors;
        if (!errors?.length || errors.some(row => row.code !== 11000)) throw error;
        // Uma criação concorrente pode vencer o upsert; reaplicar também preserva o maior total.
        await this.credits().bulkWrite(operations, { ordered: false });
      }
    }
  }
  async state(owner: string) {
    const ownerId = new Types.ObjectId(owner);
    const [totals, recent] = await Promise.all([
      this.credits().aggregate<{ _id: XpKind; units: number; xp: number }>([
        { $match: { ownerId } }, { $group: { _id: '$kind', units: { $sum: '$units' }, xp: { $sum: { $multiply: ['$units', '$rate'] } } } },
      ]).toArray(),
      this.credits().find({ ownerId }).sort({ updatedAt: -1, _id: 1 }).limit(20).toArray(),
    ]);
    const breakdown = (Object.keys(xpRules) as XpKind[]).map(kind => ({ kind, ...xpRules[kind], units: totals.find(row => row._id === kind)?.units || 0, xp: totals.find(row => row._id === kind)?.xp || 0 }));
    return { ...levelFromXp(breakdown.reduce((sum, row) => sum + row.xp, 0)), breakdown, gameHourCap: 100, recent: recent.map(row => ({ id: row._id, kind: row.kind, label: row.label, xp: row.units * row.rate, recordedAt: row.updatedAt.toISOString() })) };
  }
}
@ApiTags('progression') @ApiCookieAuth('session')
@ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
@Controller('progression')
class ProgressionController {
  constructor(private readonly service: ProgressionService, private readonly auth: AuthService) {}
  @Get() @ApiOperation({ summary: 'Consultar o nível e os créditos privados de XP', description: 'Não sincroniza. Nível geral independente das conquistas e sem teto fixo. Nível 1 inicia em zero; primeiro avanço exige 100 XP e cada avanço seguinte exige mais 25 XP.' })
  @ApiOkResponse({ type: ProgressionDto })
  async get(@Req() request: Request) { return this.service.state((await this.auth.forRequest(request)).id); }
  @Post('sync') @HttpCode(200)
  @ApiOperation({ summary: 'Reconhecer atividades e histórico no XP', description: 'Idempotente. Não aceita XP do cliente. Filme 20, revisão concluída de filme 20, episódio regular distinto 5, hora completa assistida em filmes ou episódios 5, livro 50, jogo concluído 50, hora inteira jogada 2 (primeiras 100 por jogo), avaliação com nota ou sentimento 3 por obra concluída/episódio assistido e conquista concedida 25. Séries concluídas não dão bônus além dos episódios e do tempo conhecido. Horas de filme acumulam minutos das visualizações concluídas da mesma obra; horas de série somam episódios regulares distintos com duração no cache local. Não estima duração ausente nem consulta provedores externos. Repetições de episódios não dão créditos extras. Revisões em andamento não pontuam. Datas desconhecidas e arquivos contam; itens planejados não dão XP, exceto tempo jogado já informado. Alterações/exclusões não revogam créditos reconhecidos; recadastro da mesma identidade não duplica. Horas usam o maior total sincronizado por jogo. Sem histórico diário nem prêmios cosméticos nesta versão. changed=1 processa somente alterações pendentes; sem esse parâmetro, solicita reconciliação manual. Mudanças são enfileiradas e agrupadas; ranking lê créditos persistidos e pode refletir alterações com atraso de processamento.' })
  @ApiOkResponse({ type: ProgressionDto })
  @ApiResponse({ status: 400, description: 'Parâmetro changed inválido.' })
  @ApiResponse({ status: 403, description: 'Origem não permitida.' })
  @ApiQuery({ name: 'changed', required: false, enum: ['1'], description: 'Somente processa a conta se houver atividade pendente. Omitido força reconciliação manual.' })
  async sync(@Req() request: Request, @Query('changed') changed?: string) {
    if (changed !== undefined && changed !== '1') throw new BadRequestException('Parâmetro changed inválido.');
    if (request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem da requisição não permitida.');
    return this.service.sync((await this.auth.forRequest(request)).id, changed === '1');
  }
}
@Injectable()
export class XpActivityInterceptor implements NestInterceptor {
  constructor(@InjectConnection() private readonly connection: Connection, private readonly auth: AuthService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path;
    // Leitura de páginas, prévias e conexões externas não invalidam o XP.
    const activity = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) &&
      (/^\/api\/library(?:\/[a-f0-9]{24}(?:\/(?:episodes(?:\/[^/]+)?|rewatches|runtime|playtime|game-sessions(?:\/[^/]+)?))?)?\/?$/i.test(path) || /^\/api\/game-imports\/preview\/[^/]+\/[^/]+\/apply$/.test(path));
    const copies = ['POST', 'PATCH', 'DELETE'].includes(request.method) && /^\/api\/collector(?:\/|$)/.test(path);
    if (!activity && !copies) return next.handle();
    return next.handle().pipe(mergeMap(async value => {
      try { await markXpDirty(this.connection, (await this.auth.forRequest(request)).id); }
      catch { console.warn('[XP] Não foi possível enfileirar a atividade.'); }
      return value;
    }));
  }
}
@Module({ imports: [AuthModule], providers: [ProgressionService, { provide: APP_INTERCEPTOR, useClass: XpActivityInterceptor }], controllers: [ProgressionController], exports: [ProgressionService] })
export class ProgressionModule {}
