import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, OnModuleInit, Patch, Post, Req } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { Connection, Types } from 'mongoose';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config';
import { achievements, dailyEpisodeRecord, seasonInOneDay, validTimeZone, reviewMilestones, achievementProgress, gameMilestones, type AchievementMetric } from './achievement-rules';

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
type Award = { ownerId: Types.ObjectId; key: string; unlockedAt: Date; celebratedAt?: Date; evidence?: string[] };
type Profile = { ownerId: Types.ObjectId; selectedId?: string | null; timeZone?: string; peaks?: Partial<Record<AchievementMetric, number>> };
type ReviewFields = { feeling?: string; favoriteCharacter?: string; favoriteActorId?: string; favoriteActorName?: string };
type Item = ReviewFields & { _id: Types.ObjectId; kind: string; status: string; title: string; year?: string; catalogId?: string; catalogKey?: string; stars?: number; platform?: string; playtimeMinutes?: number };
type Episode = ReviewFields & { itemId: Types.ObjectId; season: number; episode: number; watchedAt: Date; watchOrigin?: string };
type Season = { catalogId: string; number: number; total: number; loaded: boolean; episodes: { number: number; airDate?: string }[] };

class AchievementViewDto {
  @ApiProperty({ enum: ['single', 'finite', 'continuous'], description: 'single: conquista única sem estrelas/níveis; finite: estrelas por metas fixas, sem níveis; continuous: cinco estrelas por ciclo e níveis ilimitados.' }) progressionMode!: string;
  @ApiProperty({ required: false, description: 'Meta histórica descontinuada: retornada apenas se já conquistada, preservando evidência e título.' }) legacy?: boolean;
  @ApiProperty({ example: 'cinephile-10' }) id!: string;
  @ApiProperty({ enum: [...new Set(achievements.map(item => item.family))] }) family!: string;
  @ApiProperty({ example: 'Cinéfilo' }) name!: string;
  @ApiProperty({ example: 'Cinéfilo' }) title!: string;
  @ApiProperty({ example: 'Concluir {0} filmes diferentes.', description: '{0} deve ser substituído por target na apresentação.' }) description!: string;
  @ApiProperty({ enum: [...new Set(achievements.map(item => item.metric))] }) metric!: string;
  @ApiProperty({ type: 'integer', minimum: 1, example: 10 }) target!: number;
  @ApiProperty({ type: 'integer', minimum: 1, description: 'Nível desta meta na família, começando em 1.' }) level!: number;
  @ApiProperty({ type: 'integer', minimum: 1, description: 'Quantidade fixa de marcos iniciais desta família usada no preenchimento das cinco estrelas.' }) levels!: number;
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Quantidade de ciclos completos de cinco estrelas. Cada estrela equivale à última meta inicial; cada ciclo exige cinco vezes essa meta. Conquistas únicas retornam zero e não exibem nível.' }) progressionLevel!: number;
  @ApiProperty({ type: Number, minimum: 0, maximum: 5, description: 'Preenchimento das estrelas do ciclo atual pelo maior progresso sincronizado; no limite exato mantém cinco estrelas até iniciar o próximo ciclo. Zero para conquistas únicas.' }) cycleStars!: number;
  @ApiProperty({ type: 'integer', minimum: 1, description: 'Meta acumulada do próximo ciclo de cinco estrelas. Para conquistas únicas permanece a meta original.' }) nextLevelTarget!: number;
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Contagem atual; pode cair após exclusões sem revogar a conquista já salva.' }) current!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) unlockedAt!: string | null;
  @ApiProperty({ type: [String], nullable: true, description: 'Itens que contribuíram no momento do desbloqueio, incluindo temporada/episódio quando aplicável. Snapshot preservado após alterações ou exclusões. null para metas bloqueadas ou conquistas antigas sem evidência registrada; não identifica um único evento causador em importações retroativas.' }) evidence!: string[] | null;
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
  private async metrics(ownerId: Types.ObjectId, timeZone: string) {
    // Leituras locais e projeções pequenas: desbloquear conquistas nunca chama TMDB, Books ou S3.
    const [items, copies] = await Promise.all([
      this.connection.collection<Item>('library_items').find({ ownerId }, { projection: { kind: 1, status: 1, title: 1, year: 1, catalogId: 1, catalogKey: 1, stars: 1, platform: 1, playtimeMinutes: 1, feeling: 1, favoriteCharacter: 1, favoriteActorId: 1, favoriteActorName: 1 } }).toArray(),
      this.connection.collection<{ title: string }>('collector_copies').find({ ownerId }, { projection: { title: 1 } }).toArray(),
    ]);
    const distinct = (rows: Item[]) => new Set(rows.map(item => item.catalogId || item.catalogKey || `${item.title.trim().toLowerCase()}:${item.year || ''}`)).size;
    const completed = (kind: string) => distinct(items.filter(item => item.kind === kind && item.status === 'completed'));
    const movies = items.filter(item => item.kind === 'movie' && item.status === 'completed');
    const series = items.filter(item => item.kind === 'series' && item.catalogId?.startsWith('tmdb:series:'));
    const [progress, seasons] = series.length ? await Promise.all([
      this.connection.collection<Episode>('episode_progress').find({ itemId: { $in: series.map(item => item._id) }, season: { $gt: 0 } }, { projection: { itemId: 1, season: 1, episode: 1, watchedAt: 1, watchOrigin: 1, feeling: 1, favoriteCharacter: 1, favoriteActorId: 1, favoriteActorName: 1 } }).toArray(),
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
    // O snapshot explica os itens que contaram, sem inventar um evento causador no histórico importado.
    const label = (item: Item) => `${item.title}${item.year ? ` (${item.year})` : ''}`;
    const titles = (rows: Item[]) => [...new Map(rows.map(item => [item.catalogId || item.catalogKey || `${item.title.trim().toLowerCase()}:${item.year || ''}`, label(item)])).values()];
    const seasonLabel = (season: Season) => `${series.find(item => item.catalogId === season.catalogId)?.title || season.catalogId} — T${season.number}`;
    const episodeLabel = (row: Episode) => `${series.find(item => item._id.toString() === row.itemId.toString())?.title || 'Série'} — T${row.season} E${row.episode}`;
    const scope = (item: Item) => item.catalogId || item.catalogKey || `${item.kind}:${item.title.trim().toLowerCase()}:${item.year || ''}`;
    const reviewEvidence = reviewMilestones([
      ...items.filter(item => item.status === 'completed').map(item => ({ ...item, key: `item:${scope(item)}`, scope: scope(item), label: label(item) })),
      ...progress.map(row => ({ ...row, key: `episode:${key(catalogs.get(row.itemId.toString())!, row.season, row.episode)}`, scope: catalogs.get(row.itemId.toString())!, label: episodeLabel(row) })),
    ]);
    const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const days = new Map<string, typeof activity>();
    for (const row of activity) {
      if (row.watchOrigin !== 'individual' || !(row.watchedAt instanceof Date) || !Number.isFinite(row.watchedAt.getTime()) || row.watchedAt > new Date()) continue;
      const day = dayFormatter.format(row.watchedAt);
      days.set(day, [...(days.get(day) || []), row]);
    }
    const recordDay = [...days.entries()].sort((a, b) => new Set(b[1].map(row => row.key)).size - new Set(a[1].map(row => row.key)).size || a[0].localeCompare(b[0]))[0];
    const daySeasons = finishedSeasons.filter(season => seasonInOneDay(bySeason.get(`${season.catalogId}:${season.number}`) || [], [...new Set(season.episodes.map(episode => key(season.catalogId, season.number, episode.number)))], timeZone));
    const gameProgress = gameMilestones(items);
    const evidence: Record<AchievementMetric, string[]> = { ...gameProgress.evidence,
      ...reviewEvidence,
      movies: titles(movies), books: titles(items.filter(item => item.kind === 'book' && item.status === 'completed')),
      copies: copies.map(copy => copy.title), series: titles(items.filter(item => item.kind === 'series' && item.status === 'completed')),
      seasons: finishedSeasons.map(seasonLabel), episodes: [...new Set(progress.map(episodeLabel))],
      classics: titles(movies.filter(item => /^\d{4}$/.test(item.year || '') && Number(item.year) > 0 && Number(item.year) < 2000)),
      reviews: titles(movies.filter(item => Number.isInteger(item.stars) && item.stars! >= 1 && item.stars! <= 5)),
      daySeason: daySeasons.map(seasonLabel),
      binge: recordDay ? [...new Set(recordDay[1].map(row => `${episodeLabel(row)} — ${recordDay[0]}`))] : [],
    };
    const counts: Record<AchievementMetric, number> = { ...gameProgress.counts, loved: reviewEvidence.loved.length, favoriteActor: reviewEvidence.favoriteActor.length, favoriteCharacter: reviewEvidence.favoriteCharacter.length, movies: completed('movie'), books: completed('book'), copies: copies.length,
      seasons: new Set(finishedSeasons.map(season => `${season.catalogId}:${season.number}`)).size,
      series: completed('series'), episodes: watched.size,
      classics: distinct(movies.filter(item => /^\d{4}$/.test(item.year || '') && Number(item.year) > 0 && Number(item.year) < 2000)),
      reviews: distinct(movies.filter(item => Number.isInteger(item.stars) && item.stars! >= 1 && item.stars! <= 5)),
      daySeason: Number(finishedSeasons.some(season => seasonInOneDay(bySeason.get(`${season.catalogId}:${season.number}`) || [], [...new Set(season.episodes.map(episode => key(season.catalogId, season.number, episode.number)))], timeZone))),
      binge: dailyEpisodeRecord(activity, timeZone) };
    return { counts, evidence };
  }
  async state(owner: string, unlock = false, requestedZone?: string) {
    if (requestedZone !== undefined && !validTimeZone(requestedZone)) throw new BadRequestException('Fuso horário inválido.');
    const ownerId = new Types.ObjectId(owner);
    const profile = await this.profiles().findOne({ ownerId });
    const timeZone = requestedZone || profile?.timeZone || 'UTC';
    const { counts: metrics, evidence } = await this.metrics(ownerId, timeZone);
    if (unlock) {
      // O maior progresso é persistido atomicamente para não perder níveis após exclusões ou sincronizações concorrentes.
      const peaks = Object.fromEntries(Object.entries(metrics).map(([metric, count]) => [`peaks.${metric}`, count]));
      try { await this.profiles().updateOne({ ownerId }, { $max: peaks }, { upsert: true }); }
      catch (error) { if ((error as { code?: number }).code !== 11000) throw error; await this.profiles().updateOne({ ownerId }, { $max: peaks }); }
      // Índice único + setOnInsert tornam sincronizações concorrentes idempotentes.
      // Conquistas desbloqueadas permanecem, mesmo se uma obra/cópia for removida depois.
      const eligible = achievements.filter(item => !item.legacy && metrics[item.metric] >= item.target);
      if (eligible.length) try {
        // Um lote evita uma viagem ao Atlas por medalha ao reconhecer histórico antigo.
        await this.awards().bulkWrite(eligible.map(item => ({ updateOne: { filter: { ownerId, key: item.id }, update: { $setOnInsert: { ownerId, key: item.id, unlockedAt: new Date(), evidence: evidence[item.metric] } }, upsert: true } })), { ordered: false });
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
    const progression = (family: string, metric: AchievementMetric) => {
      const milestones = achievements.filter(item => item.family === family && !item.legacy);
      // Prêmios anteriores continuam comprovando os níveis iniciais mesmo antes da primeira sincronização nova.
      const earned = Math.max(0, ...milestones.filter(item => awards.has(item.id)).map(item => item.target));
      return achievementProgress(family, milestones.map(item => item.target), Math.max(earned, currentProfile?.peaks?.[metric] || 0));
    };
    return { timeZone, selectedId: currentProfile?.selectedId || null, achievements: achievements.filter(item => !item.legacy || awards.has(item.id)).map(item => ({ ...item,
      ...progression(item.family, item.metric),
      current: metrics[item.metric], unlockedAt: awards.get(item.id)?.unlockedAt.toISOString() || null, evidence: awards.get(item.id)?.evidence || null })),
      pending: achievements.filter(item => { const award = awards.get(item.id); return !item.legacy && award && !award.celebratedAt; }).map(item => item.id) };
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
  @ApiOperation({ summary: 'Consultar conquistas e progresso privados', description: 'Não desbloqueia nem marca celebrações como vistas. Retorna 18 famílias com metas ativas e registros legados já conquistados. Só mais um episódio usa metas finitas 2/3/5/8/10 sem níveis; plataformas usa 2/3/5. Jogos: primeiro zerado (única), concluir 3/5/10/25/50 jogos e acumular 10/25/50/100/250 horas totais. Tempo soma minutos inteiros dos jogos e arredonda para baixo apenas após somar; plataformas contam jogos iniciados, concluídos ou com tempo informado, normalizando caixa e espaços. Metas legadas de maratona acima de 10 não são mais concedidas. Demais famílias seguem ciclos contínuos, com level/levels para os marcos históricos, cycleStars para o ciclo atual e progressionLevel igual à quantidade de ciclos completos de cinco estrelas. Cada estrela exige a última meta inicial e cada ciclo exige cinco vezes essa meta; nextLevelTarget indica a meta acumulada do próximo ciclo. Famílias com uma única meta, incluindo Primeiro play, não têm níveis nem estrelas; o maior progresso sincronizado é preservado e os níveis extras não concedem novas medalhas ou celebrações: Primeiro play; Só mais um episódio (2/3/5/8/10); Temporada encerrada (1/5/10/25); Cinéfilo (10/25/50/100); Até o último episódio (séries marcadas concluídas: 1/5/10/25); Universo em episódios (regulares distintos: 25/100/250/500); De volta aos clássicos (filmes anteriores a 2000: 5/10/25/50); Na cadeira do crítico (filmes assistidos com nota de 1 a 5: 5/10/25/50); Hoje tem final (uma temporada completa no mesmo dia, apenas marcações individuais); Devorador de páginas (5/10/25/50); Colecionador (10/25/50/100). De coração, Fã de carteirinha e Personagem inesquecível têm metas 3/5/10/25/50. Contam avaliações distintas de obras concluídas e episódios regulares, incluindo registros em lote; editar a mesma avaliação não duplica. Ator usa ID validado; personagem usa nome normalizado dentro da mesma obra/série. A maior contagem de um mesmo ator/personagem define o progresso; evidência salva o grupo vencedor. Posse não conta como leitura. Especiais não contam como episódios/temporadas. Conquistas concedidas não são removidas ao excluir obras.' })
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
