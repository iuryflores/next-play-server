import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, OnModuleInit, Patch, Post, Req } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { Connection, Types } from 'mongoose';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config';
import { achievements, dailyEpisodeRecord, seasonInOneDay, validTimeZone, type AchievementMetric } from './achievement-rules';

class SyncDto {
  @ApiProperty({ required: false, default: 'UTC', example: 'America/Sao_Paulo', maxLength: 100, description: 'Fuso IANA do navegador usado para agrupar marcações individuais por dia civil. Ausente mantém o fuso salvo ou UTC.' })
  @IsOptional() @IsString() @MaxLength(100) timeZone?: string;
}
class TitleDto {
  @ApiProperty({ type: String, nullable: true, maxLength: 60, example: 'cinephile-10', description: 'ID de uma conquista já desbloqueada pela sessão; null remove o título do perfil.' })
  @ValidateIf((_object, value) => value !== null) @IsString() @MaxLength(60) achievementId!: string | null;
}
class CelebrationDto {
  @ApiProperty({ type: [String], maxItems: 40, uniqueItems: true, example: ['first-play-1'], description: 'Conquistas apresentadas/dispensadas pelo usuário. Só afeta as conquistas da própria sessão.' })
  @IsArray() @ArrayMaxSize(40) @ArrayUnique() @IsString({ each: true }) @MaxLength(60, { each: true }) ids!: string[];
}
type Award = { ownerId: Types.ObjectId; key: string; unlockedAt: Date; celebratedAt?: Date };
type Profile = { ownerId: Types.ObjectId; selectedId?: string | null; timeZone?: string };
type Item = { _id: Types.ObjectId; kind: string; status: string; title: string; year?: string; catalogId?: string; catalogKey?: string; stars?: number };
type Episode = { itemId: Types.ObjectId; season: number; episode: number; watchedAt: Date; watchOrigin?: string };
type Season = { catalogId: string; number: number; total: number; loaded: boolean; episodes: { number: number; airDate?: string }[] };

class AchievementViewDto {
  @ApiProperty({ example: 'cinephile-10' }) id!: string;
  @ApiProperty({ enum: [...new Set(achievements.map(item => item.family))] }) family!: string;
  @ApiProperty({ example: 'Cinéfilo' }) name!: string;
  @ApiProperty({ example: 'Cinéfilo' }) title!: string;
  @ApiProperty({ example: 'Concluir {0} filmes diferentes.', description: '{0} deve ser substituído por target na apresentação.' }) description!: string;
  @ApiProperty({ enum: [...new Set(achievements.map(item => item.metric))] }) metric!: string;
  @ApiProperty({ type: 'integer', minimum: 1, example: 10 }) target!: number;
  @ApiProperty({ type: 'integer', minimum: 1, description: 'Nível desta meta na família, começando em 1.' }) level!: number;
  @ApiProperty({ type: 'integer', minimum: 1, description: 'Total de níveis disponíveis nesta família.' }) levels!: number;
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Contagem atual; pode cair após exclusões sem revogar a conquista já salva.' }) current!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) unlockedAt!: string | null;
}
class AchievementStateDto {
  @ApiProperty({ example: 'America/Sao_Paulo' }) timeZone!: string;
  @ApiProperty({ type: String, nullable: true }) selectedId!: string | null;
  @ApiProperty({ type: [String], description: 'IDs desbloqueados cuja celebração ainda não foi confirmada.' }) pending!: string[];
  @ApiProperty({ type: [AchievementViewDto] }) achievements!: AchievementViewDto[];
}
class TitleResultDto { @ApiProperty({ type: String, nullable: true }) selectedId!: string | null; }
class CelebrationResultDto { @ApiProperty({ type: [String] }) acknowledged!: string[]; }

@Injectable()
export class AchievementsService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private awards() { return this.connection.collection<Award>('achievement_awards'); }
  private profiles() { return this.connection.collection<Profile>('achievement_profiles'); }
  async onModuleInit() {
    await Promise.all([
      this.awards().createIndex({ ownerId: 1, key: 1 }, { unique: true }),
      this.profiles().createIndex({ ownerId: 1 }, { unique: true }),
    ]);
  }
  private async metrics(ownerId: Types.ObjectId, timeZone: string): Promise<Record<AchievementMetric, number>> {
    // Leituras locais e projeções pequenas: desbloquear conquistas nunca chama TMDB, Books ou S3.
    const [items, copies] = await Promise.all([
      this.connection.collection<Item>('library_items').find({ ownerId }, { projection: { kind: 1, status: 1, title: 1, year: 1, catalogId: 1, catalogKey: 1, stars: 1 } }).toArray(),
      this.connection.collection('collector_copies').countDocuments({ ownerId }),
    ]);
    const distinct = (rows: Item[]) => new Set(rows.map(item => item.catalogId || item.catalogKey || `${item.title.trim().toLowerCase()}:${item.year || ''}`)).size;
    const completed = (kind: string) => distinct(items.filter(item => item.kind === kind && item.status === 'completed'));
    const movies = items.filter(item => item.kind === 'movie' && item.status === 'completed');
    const series = items.filter(item => item.kind === 'series' && item.catalogId?.startsWith('tmdb:series:'));
    const [progress, seasons] = series.length ? await Promise.all([
      this.connection.collection<Episode>('episode_progress').find({ itemId: { $in: series.map(item => item._id) }, season: { $gt: 0 } }, { projection: { itemId: 1, season: 1, episode: 1, watchedAt: 1, watchOrigin: 1 } }).toArray(),
      this.connection.collection<Season>('series_seasons').find({ catalogId: { $in: series.map(item => item.catalogId!) }, number: { $gt: 0 }, loaded: true }, { projection: { catalogId: 1, number: 1, total: 1, loaded: 1, 'episodes.number': 1, 'episodes.airDate': 1 } }).toArray(),
    ]) : [[], []];
    const catalogs = new Map(series.map(item => [item._id.toString(), item.catalogId!]));
    const key = (catalogId: string, season: number, episode: number) => `${catalogId}:${season}:${episode}`;
    const watched = new Set(progress.map(row => key(catalogs.get(row.itemId.toString())!, row.season, row.episode)));
    const today = new Date().toISOString().slice(0, 10);
    const finishedSeasons = seasons.filter(season => {
      const numbers = new Set(season.episodes.filter(episode => episode.number > 0).map(episode => episode.number));
      // Temporada parcialmente importada ou com episódios futuros não está encerrada.
      return season.total > 0 && numbers.size >= season.total && season.episodes.every(episode => (!episode.airDate || episode.airDate <= today) && watched.has(key(season.catalogId, season.number, episode.number)));
    });
    const activity = progress.map(row => ({ ...row, key: key(catalogs.get(row.itemId.toString())!, row.season, row.episode) }));
    // Agrupa uma vez para não reformatar o histórico inteiro a cada temporada concluída.
    const bySeason = new Map<string, typeof activity>();
    for (const row of activity) {
      const seasonKey = `${catalogs.get(row.itemId.toString())!}:${row.season}`;
      const rows = bySeason.get(seasonKey) || [];
      rows.push(row);
      bySeason.set(seasonKey, rows);
    }
    // As novas famílias reutilizam somente dados da conta; não dependem de chamadas externas.
    return { movies: completed('movie'), books: completed('book'), copies,
      seasons: new Set(finishedSeasons.map(season => `${season.catalogId}:${season.number}`)).size,
      series: completed('series'), episodes: watched.size,
      classics: distinct(movies.filter(item => /^\d{4}$/.test(item.year || '') && Number(item.year) > 0 && Number(item.year) < 2000)),
      reviews: distinct(movies.filter(item => Number.isInteger(item.stars) && item.stars! >= 1 && item.stars! <= 5)),
      daySeason: Number(finishedSeasons.some(season => seasonInOneDay(bySeason.get(`${season.catalogId}:${season.number}`) || [], [...new Set(season.episodes.map(episode => key(season.catalogId, season.number, episode.number)))], timeZone))),
      binge: dailyEpisodeRecord(activity, timeZone) };
  }
  async state(owner: string, unlock = false, requestedZone?: string) {
    if (requestedZone !== undefined && !validTimeZone(requestedZone)) throw new BadRequestException('Fuso horário inválido.');
    const ownerId = new Types.ObjectId(owner);
    const profile = await this.profiles().findOne({ ownerId });
    const timeZone = requestedZone || profile?.timeZone || 'UTC';
    const metrics = await this.metrics(ownerId, timeZone);
    if (unlock) {
      // Índice único + setOnInsert tornam sincronizações concorrentes idempotentes.
      // Conquistas desbloqueadas permanecem, mesmo se uma obra/cópia for removida depois.
      const eligible = achievements.filter(item => metrics[item.metric] >= item.target);
      if (eligible.length) try {
        // Um lote evita uma viagem ao Atlas por medalha ao reconhecer histórico antigo.
        await this.awards().bulkWrite(eligible.map(item => ({ updateOne: { filter: { ownerId, key: item.id }, update: { $setOnInsert: { ownerId, key: item.id, unlockedAt: new Date() } }, upsert: true } })), { ordered: false });
      } catch (error) {
        const errors = (error as { writeErrors?: { code: number }[] }).writeErrors;
        if (!errors?.length || errors.some(item => item.code !== 11000)) throw error;
      }
      if (requestedZone) {
        try { await this.profiles().updateOne({ ownerId }, { $set: { timeZone } }, { upsert: true }); }
        catch (error) { if ((error as { code?: number }).code !== 11000) throw error; await this.profiles().updateOne({ ownerId }, { $set: { timeZone } }); }
      }
    }
    const [rows, currentProfile] = await Promise.all([this.awards().find({ ownerId }).toArray(), this.profiles().findOne({ ownerId })]);
    const awards = new Map(rows.map(row => [row.key, row]));
    return { timeZone, selectedId: currentProfile?.selectedId || null, achievements: achievements.map(item => ({ ...item,
      current: metrics[item.metric], unlockedAt: awards.get(item.id)?.unlockedAt.toISOString() || null })),
      pending: achievements.filter(item => { const award = awards.get(item.id); return award && !award.celebratedAt; }).map(item => item.id) };
  }
  async selectTitle(owner: string, id: string | null) {
    const ownerId = new Types.ObjectId(owner);
    if (id !== null && (!achievements.some(item => item.id === id) || !await this.awards().findOne({ ownerId, key: id }))) throw new BadRequestException('Desbloqueie esta conquista antes de usar o título.');
    try { await this.profiles().updateOne({ ownerId }, { $set: { selectedId: id } }, { upsert: true }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; await this.profiles().updateOne({ ownerId }, { $set: { selectedId: id } }); }
    return { selectedId: id };
  }
  async celebrate(owner: string, ids: string[]) {
    if (ids.some(id => !achievements.some(item => item.id === id))) throw new BadRequestException('Conquista inválida.');
    await this.awards().updateMany({ ownerId: new Types.ObjectId(owner), key: { $in: ids }, celebratedAt: { $exists: false } }, { $set: { celebratedAt: new Date() } });
    return { acknowledged: ids };
  }
}

@ApiTags('achievements') @ApiCookieAuth('session')
@ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
@Controller('achievements')
export class AchievementsController {
  constructor(private readonly service: AchievementsService, private readonly auth: AuthService) {}
  private async owner(request: Request) {
    if (request.method !== 'GET' && request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem da requisição não permitida.');
    return (await this.auth.forRequest(request)).id;
  }
  @Get()
  @ApiOperation({ summary: 'Consultar conquistas e progresso privados', description: 'Não desbloqueia nem marca celebrações como vistas. Retorna 11 famílias e 54 metas, com level/levels para apresentar estrelas: Primeiro play; Só mais um episódio (5 em 5, até 100); Temporada encerrada (1/5/10/25); Cinéfilo (10/25/50/100); Até o último episódio (séries marcadas concluídas: 1/5/10/25); Universo em episódios (regulares distintos: 25/100/250/500); De volta aos clássicos (filmes anteriores a 2000: 5/10/25/50); Na cadeira do crítico (filmes assistidos com nota de 1 a 5: 5/10/25/50); Hoje tem final (uma temporada completa no mesmo dia, apenas marcações individuais); Devorador de páginas (5/10/25/50); Colecionador (10/25/50/100). Posse não conta como leitura. Especiais não contam como episódios/temporadas. Conquistas concedidas não são removidas ao excluir obras.' })
  @ApiOkResponse({ type: AchievementStateDto, description: 'Progresso atual, histórico persistido e celebrações pendentes da sessão.' })
  async get(@Req() request: Request) { return this.service.state(await this.owner(request)); }
  @Post('sync')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sincronizar conquistas com os registros da conta', description: 'Idempotente; metas são calculadas no servidor, sem aceitar pontos/contagens do cliente. Histórico atual de filmes/livros/posse e temporadas pode conceder conquistas retroativas. Maratonas usam apenas marcações individuais novas, identificadas pelo servidor; lotes, conclusões integrais e datas legadas ficam excluídos. Conta o maior número de episódios distintos em um dia civil no fuso IANA informado. Hoje tem final exige temporada completa, carregada e sem episódios futuros, com todos os episódios individuais no mesmo dia; não exige que a série inteira tenha terminado. Até o último episódio conta o status concluído explicitamente informado pelo usuário, inclusive séries manuais. Não consulta catálogos externos. pending inclui celebrações ainda não confirmadas, inclusive de sessões anteriores.' })
  @ApiOkResponse({ type: AchievementStateDto, description: 'Mesmo estado retornado pelo GET, após conceder conquistas elegíveis.' })
  @ApiResponse({ status: 400, description: 'Fuso inválido ou campos não permitidos.' })
  @ApiResponse({ status: 403, description: 'Origin diferente de CLIENT_ORIGIN.' })
  async sync(@Req() request: Request, @Body() dto: SyncDto) { return this.service.state(await this.owner(request), true, dto.timeZone); }
  @Patch('title')
  @ApiOperation({ summary: 'Escolher título já conquistado para o perfil', description: 'achievementId=null remove o título. Nunca aceita conquista de outra conta ou ainda bloqueada.' })
  @ApiOkResponse({ type: TitleResultDto })
  @ApiResponse({ status: 400, description: 'Conquista desconhecida, bloqueada ou corpo inválido.' })
  @ApiResponse({ status: 403, description: 'Origin diferente de CLIENT_ORIGIN.' })
  async title(@Req() request: Request, @Body() dto: TitleDto) { return this.service.selectTitle(await this.owner(request), dto.achievementId); }
  @Post('celebrations')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirmar celebrações apresentadas ou dispensadas', description: 'Idempotente e restrito ao dono. Fechar todas pode enviar todos os IDs pendentes; abrir uma celebração não confirma automaticamente sua visualização.' })
  @ApiOkResponse({ type: CelebrationResultDto })
  @ApiResponse({ status: 400, description: 'IDs inválidos, duplicados ou mais de 40 IDs.' })
  @ApiResponse({ status: 403, description: 'Origin diferente de CLIENT_ORIGIN.' })
  async celebrate(@Req() request: Request, @Body() dto: CelebrationDto) { return this.service.celebrate(await this.owner(request), dto.ids); }
}
@Module({ imports: [AuthModule], providers: [AchievementsService], controllers: [AchievementsController] })
export class AchievementsModule {}
