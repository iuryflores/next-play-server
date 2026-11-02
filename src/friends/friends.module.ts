import { ApiProperty, ApiTags, ApiCookieAuth, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Post, HttpCode, Injectable, Module, Param, Query, Req, ForbiddenException, BadRequestException, NotFoundException, ConflictException, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { IsMongoId, IsString, MaxLength, MinLength, Matches, IsIn, IsOptional } from 'class-validator';
import { achievements, continuousLevel } from '../achievements/achievement-rules';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { LibraryModule, LibraryService } from '../library/library.module';
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
class FriendsService implements OnModuleInit {
  constructor(@InjectModel(Friendship.name) private readonly friends: Model<Friendship>, @InjectConnection() private readonly connection: Connection, private readonly library: LibraryService) {}
  async onModuleInit() { await this.friends.init(); }
  private member(id: string) { return { $or: [{ sender: id }, { receiver: id }] }; }
  async profile(id: string, name: string) { await this.connection.collection('users').updateOne({ _id: new Types.ObjectId(id) }, { $set: { displayName: name.trim() } }); }
  async invite(id: string, code: string) {
    const target = code.toLowerCase();
    if (id === target) throw new BadRequestException('Você não pode adicionar a si mesmo.');
    if (!await this.connection.collection('users').findOne({ _id: new Types.ObjectId(target) }, { projection: { _id: 1 } })) throw new NotFoundException('Código de amigo não encontrado.');
    if (await this.friends.countDocuments(this.member(id)) >= 100) throw new BadRequestException('Você atingiu o limite de 100 conexões.');
    if (await this.friends.countDocuments({ sender: id, status: 'pending' }) >= 20) throw new BadRequestException('Você já tem 20 pedidos pendentes.');
    try { await this.friends.create({ pair: [id, target].sort().join(':'), sender: id, receiver: target, status: 'pending' }); }
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
    const links = await this.friends.find(this.member(id)).sort({ _id: -1 }).lean().exec();
    const ids = [...new Set([id, ...links.flatMap(link => [link.sender, link.receiver])])];
    const users = await this.connection.collection('users').find(scope === 'all' ? {} : { _id: { $in: ids.map(id => new Types.ObjectId(id)) } }, { projection: { displayName: 1 } }).toArray();
    // Só o título selecionado é público; avaliações, evidências e demais conquistas ficam privadas.
    const profiles = await this.connection.collection('achievement_profiles').find({ ownerId: { $in: users.map(user => user._id) } }, { projection: { ownerId: 1, selectedId: 1, peaks: 1 } }).toArray();
    const awards = await this.connection.collection('achievement_awards').find({ ownerId: { $in: users.map(user => user._id) } }, { projection: { ownerId: 1, key: 1 } }).toArray();
    const achievement = (userId: string) => {
      const profile = profiles.find(row => row.ownerId.toString() === userId);
      const selected = achievements.find(row => row.id === profile?.selectedId);
      if (!selected || !awards.some(row => row.ownerId.toString() === userId && row.key === selected.id)) return null;
      const family = achievements.filter(row => row.family === selected.family);
      const peak = Math.max(profile?.peaks?.[selected.metric] || 0, ...family.filter(item => awards.some(row => row.ownerId.toString() === userId && row.key === item.id)).map(item => item.target));
      return { id: selected.id, family: selected.family, title: selected.title, level: selected.level, levels: selected.levels, ...continuousLevel(family.map(item => item.target), peak) };
    };
    const name = (userId: string) => users.find(user => user._id.toString() === userId)?.displayName || `Player ${userId.slice(-6)}`;
    const rankingIds = scope === 'all' ? users.map(user => user._id.toString()) : [id, ...links.filter(link => link.status === 'accepted').map(link => link.sender === id ? link.receiver : link.sender)];
    const ranked: { id: string; name: string; me: boolean; minutes: number; episodes: number; incomplete: boolean; achievement: ReturnType<typeof achievement> }[] = [];
    for (const userId of rankingIds) {
      const stats = await this.library.stats(userId);
      ranked.push({ id: userId, name: name(userId), me: userId === id, minutes: stats.minutes, episodes: stats.episodes, incomplete: stats.missingRuntime > 0 || stats.pendingSeries > 0, achievement: achievement(userId) });
    }
    ranked.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const comparison = await compareRankingVisit(this.connection, id, scope === 'all' ? 'users' : 'friends', visitId, { friends: positions(ranked.map(entry => ({ id: entry.id, count: entry.minutes }))) });
    const ranking = ranked.map(entry => ({ ...entry, rank: comparison.rankingPositions.friends[entry.id], movement: comparison.rankingChanges.friends?.[entry.id] })).sort((a, b) => a.rank - b.rank);
    return { code: id, name: name(id), connections: links.map(link => ({ id: link._id.toString(), name: name(link.sender === id ? link.receiver : link.sender), status: link.status, incoming: link.receiver === id })), ranking };
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
  @ApiOperation({ summary: 'Listar amigos ou todos os usuários e seu ranking', description: 'Requer sessão. Retorna code, name, connections (amizades e pedidos) e ranking do escopo solicitado, incluindo posição, movimento, nome público, tempo, episódios e achievement (título escolhido e progresso ou null). Não retorna emails, coleção, avaliações ou evidências de conquistas. Rankings dos dois escopos mantêm históricos de movimento independentes.' })
  @ApiOkResponse({ description: 'Perfil da sessão, conexões e ranking do escopo friends (padrão) ou all.' })
  async list(@Req() request: Request, @Query() query: FriendsQueryDto) { return this.friends.list(await this.owner(request), request.get('X-Ranking-Visit'), query.scope); }
  @Post('profile') @HttpCode(204) async profile(@Req() request: Request, @Body() dto: FriendProfileDto) { await this.friends.profile(await this.owner(request), dto.name); }
  @Post('requests') @HttpCode(204) async invite(@Req() request: Request, @Body() dto: InviteDto) { await this.friends.invite(await this.owner(request), dto.code); }
  @Post(':id/accept') @HttpCode(204) async accept(@Req() request: Request, @Param('id') id: string) { await this.friends.accept(await this.owner(request), id); }
  @Delete(':id') @HttpCode(204) async remove(@Req() request: Request, @Param('id') id: string) { await this.friends.remove(await this.owner(request), id); }
}
@Module({ imports: [AuthModule, LibraryModule, MongooseModule.forFeature([{ name: Friendship.name, schema: FriendshipSchema }])], controllers: [FriendsController], providers: [FriendsService] })
export class FriendsModule {}
