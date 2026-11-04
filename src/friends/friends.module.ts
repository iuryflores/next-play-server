import { readTiming } from '../read-timing';
import { rankingSummaries } from '../library/ranking-summary';
import { saveNotification } from '../notifications/notification-store';
import { levelFromXp } from '../progression/progression-rules';
import { ProgressionModule } from '../progression/progression.module';
import { ApiProperty, ApiTags, ApiCookieAuth, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Post, HttpCode, Injectable, Module, Param, Query, Req, ForbiddenException, BadRequestException, NotFoundException, ConflictException, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { IsMongoId, IsString, MaxLength, MinLength, Matches, IsIn, IsOptional } from 'class-validator';
import { achievements, achievementProgress } from '../achievements/achievement-rules';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { AvatarStorage } from '../auth/avatar-storage';

import { getConfig } from '../config';
import { positions } from '../library/ranking-snapshot';
import { compareRankingVisit } from '../library/ranking-visits';
@Schema({ collection: 'friendships', timestamps: true })
class Friendship {
  @Prop({ required: true, unique: true }) pair!: string;
  @Prop({ required: true, index: true }) sender!: string;
  @Prop({ required: true, index: true }) receiver!: string;
  @Prop({ enum: ['pending', 'accepted'], default: 'pending' }) status!: string;
}
const FriendshipSchema = SchemaFactory.createForClass(Friendship);
class InviteDto { @ApiProperty({ type: String, required: true })
  @IsMongoId() code!: string; }
class FriendsQueryDto {
  @ApiProperty({ required: false, enum: ['friends', 'all'], default: 'friends', description: 'friends inclui você e amizades aceitas; all inclui todos os usuários. Ambos ordenam por tempo em séries e exibem apenas o título de conquista escolhido, sem evidências privadas.' })
  @IsOptional() @IsIn(['friends', 'all']) scope?: 'friends' | 'all';
}
class FriendProfileDto { @ApiProperty({ type: String, required: true, minLength: 1, maxLength: 40 })
  @IsString() @MinLength(1) @MaxLength(40) @Matches(/\S/) name!: string; }
@Injectable()
export class FriendsService implements OnModuleInit {
  constructor(@InjectModel(Friendship.name) private readonly friends: Model<Friendship>, @InjectConnection() private readonly connection: Connection, private readonly avatars: AvatarStorage) {}
  async onModuleInit() { await this.friends.init(); }
  private member(id: string) { return { $or: [{ sender: id }, { receiver: id }] }; }
  async profile(id: string, name: string) { await this.connection.collection('users').updateOne({ _id: new Types.ObjectId(id) }, { $set: { displayName: name.trim() } }); }
  async invite(id: string, code: string) {
    const target = code.toLowerCase();
    if (id === target) throw new BadRequestException('Você não pode adicionar a si mesmo.');
    if (!await this.connection.collection('users').findOne({ _id: new Types.ObjectId(target) }, { projection: { _id: 1 } })) throw new NotFoundException('Código de amigo não encontrado.');
    if (await this.friends.countDocuments(this.member(id)) >= 100) throw new BadRequestException('Você atingiu o limite de 100 conexões.');
    if (await this.friends.countDocuments({ sender: id, status: 'pending' }) >= 20) throw new BadRequestException('Você já tem 20 pedidos pendentes.');
    try {
      const invitation = await this.friends.create({ pair: [id, target].sort().join(':'), sender: id, receiver: target, status: 'pending' });
      await saveNotification(this.connection, { ownerId: new Types.ObjectId(target), kind: 'friend-request', sourceId: invitation._id.toString(), senderId: id, createdAt: new Date() });
    }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new ConflictException('Vocês já são amigos ou têm um pedido pendente.'); throw error; }
  }
  async accept(id: string, requestId: string) {
    if (!Types.ObjectId.isValid(requestId)) throw new NotFoundException('Pedido não encontrado.');
    const result = await this.friends.findOneAndUpdate({ _id: requestId, receiver: id, status: 'pending' }, { $set: { status: 'accepted' } });
    if (!result) throw new NotFoundException('Pedido não encontrado.');
  }
  async remove(id: string, requestId: string) {
    if (!Types.ObjectId.isValid(requestId) || !await this.friends.findOneAndDelete({ _id: requestId, ...this.member(id) })) throw new NotFoundException('Pedido não encontrado.');
  }
  async list(id: string, visitId?: string, scope: 'friends' | 'all' = 'friends') {
    const timing = readTiming('amigos');
    const links = await this.friends.find(this.member(id)).sort({ _id: -1 }).lean().exec();
    timing.mark('amizades');
    const ids = [...new Set([id, ...links.flatMap(link => [link.sender, link.receiver])])];
    const users = await this.connection.collection('users').find(scope === 'all' ? {} : { _id: { $in: ids.map(id => new Types.ObjectId(id)) } }, { projection: { displayName: 1, avatar: 1, avatarKey: 1 } }).toArray();
    timing.mark('usuarios');
    // Só o título selecionado é público; avaliações, evidências e demais conquistas ficam privadas.
    const rankingIds = scope === 'all' ? users.map(user => user._id.toString()) : [id, ...links.filter(link => link.status === 'accepted').map(link => link.sender === id ? link.receiver : link.sender)];
    // O ranking lê créditos já reconhecidos; contas alteradas são atualizadas pela fila fora desta requisição.
    // Só os totais são públicos. Consultas em lote evitam buscar o histórico privado de XP por usuário.
    const ownerIds = rankingIds.map(value => new Types.ObjectId(value));
    // Totais, XP e títulos públicos são independentes e não precisam somar cinco viagens ao banco.
    const [completed, credits, summaries, profiles, awards] = await Promise.all([
      this.connection.collection('library_items').find({ ownerId: { $in: ownerIds }, $or: [{ kind: { $in: ['book', 'game', 'movie'] }, status: 'completed' }, { kind: 'game', playtimeMinutes: { $gt: 0 } }] }, { projection: { ownerId: 1, kind: 1, title: 1, year: 1, catalogId: 1, catalogKey: 1, status: 1, runtime: 1, playtimeMinutes: 1 } }).toArray(),
      this.connection.collection('user_xp_credits').aggregate<{ _id: Types.ObjectId; xp: number }>([
        { $match: { ownerId: { $in: ownerIds } } },
        { $group: { _id: '$ownerId', xp: { $sum: { $multiply: ['$units', '$rate'] } } } },
      ]).toArray(),
      rankingSummaries(this.connection, rankingIds),
      this.connection.collection('achievement_profiles').find({ ownerId: { $in: users.map(user => user._id) } }, { projection: { ownerId: 1, selectedId: 1, peaks: 1 } }).toArray(),
      this.connection.collection('achievement_awards').find({ ownerId: { $in: users.map(user => user._id) } }, { projection: { ownerId: 1, key: 1 } }).toArray(),
    ]);
    timing.mark('totais_xp_conquistas');
    const achievement = (userId: string) => {
      const profile = profiles.find(row => row.ownerId.toString() === userId);
      const selected = achievements.find(row => row.id === profile?.selectedId);
      if (!selected || !awards.some(row => row.ownerId.toString() === userId && row.key === selected.id)) return null;
      const family = achievements.filter(row => row.family === selected.family && !row.legacy);
      const peak = Math.max(profile?.peaks?.[selected.metric] || 0, ...family.filter(item => awards.some(row => row.ownerId.toString() === userId && row.key === item.id)).map(item => item.target));
      return { id: selected.id, family: selected.family, title: selected.title, level: selected.level, levels: selected.levels, ...achievementProgress(selected.family, family.map(item => item.target), peak) };
    };
    const name = (userId: string) => users.find(user => user._id.toString() === userId)?.displayName || `Player ${userId.slice(-6)}`;
    const counts = new Map<string, { books: Set<string>; games: Set<string>; movies: Map<string, number>; gameMinutes: number }>();
    for (const item of completed) {
      const userId = item.ownerId.toString();
      const entry = counts.get(userId) || { books: new Set<string>(), games: new Set<string>(), movies: new Map<string, number>(), gameMinutes: 0 };
      const identity = item.catalogId || item.catalogKey || `${item.title.trim().toLowerCase()}:${item.year || ''}`;
      // Filmes contam uma vez por título; durações ausentes não são estimadas. Jogos incluem sessões em andamento e arquivados.
      if (item.kind === 'movie') entry.movies.set(identity, Math.max(entry.movies.get(identity) || 0, Number.isFinite(item.runtime) && item.runtime > 0 ? item.runtime : 0));
      else if (item.kind === 'game') {
        if (item.status === 'completed') entry.games.add(identity);
        if (Number.isFinite(item.playtimeMinutes) && item.playtimeMinutes > 0) entry.gameMinutes += item.playtimeMinutes;
      } else entry.books.add(identity);
      counts.set(userId, entry);
    }
    const xpByOwner = new Map(credits.map(row => [row._id.toString(), row.xp]));
    const ranked: { id: string; name: string; avatar: string; connection: { id: string; status: string; incoming: boolean } | null; me: boolean; minutes: number; movieMinutes: number; gameMinutes: number; movies: number; episodes: number; books: number; games: number; xp: number; level: number; incomplete: boolean; achievement: ReturnType<typeof achievement> }[] = [];
    // As leituras informativas independentes usam lotes pequenos, sem esperar cada pessoa em sequência.
    for (let offset = 0; offset < rankingIds.length; offset += 4) {
      await Promise.all(rankingIds.slice(offset, offset + 4).map(async userId => {
      const stats = summaries.get(userId)!;
      const user = users.find(user => user._id.toString() === userId);
      // URLs temporárias não expõem credenciais; falha da foto não impede consultar o ranking.
      const avatar = user?.avatarKey ? await this.avatars.signedUrl(user.avatarKey).catch(() => '') : user?.avatar || '';
      const link = links.find(link => link.sender === userId || link.receiver === userId);
      const xp = xpByOwner.get(userId) || 0;
      ranked.push({ id: userId, name: name(userId), avatar, connection: userId !== id && link ? { id: link._id.toString(), status: link.status, incoming: link.receiver === id } : null, me: userId === id, minutes: stats.minutes, movieMinutes: [...(counts.get(userId)?.movies.values() || [])].reduce((sum, value) => sum + value, 0), gameMinutes: counts.get(userId)?.gameMinutes || 0, movies: counts.get(userId)?.movies.size || 0, episodes: stats.episodes, books: counts.get(userId)?.books.size || 0, games: counts.get(userId)?.games.size || 0, xp, level: levelFromXp(xp).level, incomplete: stats.missingRuntime > 0 || stats.pendingSeries > 0, achievement: achievement(userId) });
      }));
    }
    timing.mark('perfis_e_fotos');
    ranked.sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    // O novo critério tem histórico próprio para não mostrar subidas/quedas
    // causadas apenas pela troca do ranking antigo por tempo para o ranking por XP.
    const comparison = await compareRankingVisit(this.connection, id, scope === 'all' ? 'users:xp' : 'friends:xp', visitId, { friends: positions(ranked.map(entry => ({ id: entry.id, count: entry.xp }))) }, true);
    const ranking = ranked.map(entry => ({ ...entry, rank: comparison.rankingPositions.friends[entry.id], movement: comparison.rankingChanges.friends?.[entry.id] })).sort((a, b) => a.rank - b.rank);
    timing.mark('posicoes');
    timing.finish();
    return { rankingMetric: 'xp', code: id, name: name(id), connections: links.map(link => ({ id: link._id.toString(), name: name(link.sender === id ? link.receiver : link.sender), status: link.status, incoming: link.receiver === id })), ranking };
  }
}
@ApiTags('friends')
@ApiCookieAuth('session')
@Controller('friends')
class FriendsController {
  constructor(private readonly friends: FriendsService, private readonly auth: AuthService) {}
  private async owner(request: Request) {
    if (request.method !== 'GET' && request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem da requisição não permitida.');
    const token: unknown = request.cookies?.[getConfig().cookieName];
    return (await this.auth.me(typeof token === 'string' ? token : undefined)).id;
  }
  @Get()
  @ApiOperation({ summary: 'Listar amigos ou todos os usuários e seu ranking', description: 'Requer sessão. Retorna code, name, connections (amizades e pedidos) e ranking do escopo solicitado, incluindo posição, movimento, nome público, avatar (URL temporária ou foto legada; vazio se indisponível), connection (id/status/incoming ou null), minutes (minutos em séries), movieMinutes (minutos conhecidos dos filmes concluídos distintos, sem somar revisões), movies (filmes concluídos distintos), gameMinutes (tempo registrado em jogos em qualquer status, incluindo arquivados), episódios, books (livros lidos distintos), games (jogos concluídos distintos), xp (XP total já reconhecido e persistido), level (nível geral correspondente) e achievement (título escolhido e progresso ou null). Não retorna emails, coleção, avaliações ou evidências de conquistas. Contagens incluem arquivados, excluem planejados/em andamento e não expõem nomes de obras. Atividades e histórico são reconhecidos pela fila em segundo plano, sem depender de login recente. Esta consulta somente lê os créditos persistidos; mudanças podem aparecer com atraso de processamento. O reconhecimento é idempotente e não aceita pontos do cliente; apenas créditos novos ou horas adicionais são gravados. Ordena por XP total decrescente. XP igual compartilha a colocação (1, 1, 3); nome e ID apenas estabilizam a exibição, sem desempatar pontos. Tempos são informativos. Filmes sem duração contam em movies, mas não em movieMinutes. Cópias do mesmo filme não duplicam tempo nem quantidade; usa a maior duração conhecida entre elas. Os escopos têm históricos de movimento por XP independentes, reiniciados na troca de critério para não comparar com o antigo ranking por tempo.' })
  @ApiOkResponse({ description: 'Perfil da sessão, conexões, rankingMetric=xp e ranking do escopo friends (padrão) ou all, ordenado por XP e com posição compartilhada nos empates.' })
  async list(@Req() request: Request, @Query() query: FriendsQueryDto) { return this.friends.list(await this.owner(request), request.get('X-Ranking-Visit'), query.scope); }
  @Post('profile') @HttpCode(204) async profile(@Req() request: Request, @Body() dto: FriendProfileDto) { await this.friends.profile(await this.owner(request), dto.name); }
  @Post('requests') @HttpCode(204) async invite(@Req() request: Request, @Body() dto: InviteDto) { await this.friends.invite(await this.owner(request), dto.code); }
  @Post(':id/accept') @HttpCode(204) async accept(@Req() request: Request, @Param('id') id: string) { await this.friends.accept(await this.owner(request), id); }
  @Delete(':id') @HttpCode(204) async remove(@Req() request: Request, @Param('id') id: string) { await this.friends.remove(await this.owner(request), id); }
}
@Module({ imports: [AuthModule, ProgressionModule, MongooseModule.forFeature([{ name: Friendship.name, schema: FriendshipSchema }])], controllers: [FriendsController], providers: [FriendsService] })
export class FriendsModule {}
