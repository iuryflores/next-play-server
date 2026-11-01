import { ApiProperty, ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Post, HttpCode, Injectable, Module, Param, Req, ForbiddenException, BadRequestException, NotFoundException, ConflictException, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { IsMongoId, IsString, MaxLength, MinLength, Matches } from 'class-validator';
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
  async list(id: string, visitId?: string) {
    const links = await this.friends.find(this.member(id)).sort({ _id: -1 }).lean().exec();
    const ids = [...new Set([id, ...links.flatMap(link => [link.sender, link.receiver])])];
    const users = await this.connection.collection('users').find({ _id: { $in: ids.map(id => new Types.ObjectId(id)) } }, { projection: { displayName: 1 } }).toArray();
    const name = (userId: string) => users.find(user => user._id.toString() === userId)?.displayName || `Player ${userId.slice(-6)}`;
    const rankingIds = [id, ...links.filter(link => link.status === 'accepted').map(link => link.sender === id ? link.receiver : link.sender)];
    const ranked: { id: string; name: string; me: boolean; minutes: number; episodes: number; incomplete: boolean }[] = [];
    for (const userId of rankingIds) {
      const stats = await this.library.stats(userId);
      ranked.push({ id: userId, name: name(userId), me: userId === id, minutes: stats.minutes, episodes: stats.episodes, incomplete: stats.missingRuntime > 0 || stats.pendingSeries > 0 });
    }
    ranked.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const comparison = await compareRankingVisit(this.connection, id, 'friends', visitId, { friends: positions(ranked.map(entry => ({ id: entry.id, count: entry.minutes }))) });
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
  @Get() async list(@Req() request: Request) { return this.friends.list(await this.owner(request), request.get('X-Ranking-Visit')); }
  @Post('profile') @HttpCode(204) async profile(@Req() request: Request, @Body() dto: FriendProfileDto) { await this.friends.profile(await this.owner(request), dto.name); }
  @Post('requests') @HttpCode(204) async invite(@Req() request: Request, @Body() dto: InviteDto) { await this.friends.invite(await this.owner(request), dto.code); }
  @Post(':id/accept') @HttpCode(204) async accept(@Req() request: Request, @Param('id') id: string) { await this.friends.accept(await this.owner(request), id); }
  @Delete(':id') @HttpCode(204) async remove(@Req() request: Request, @Param('id') id: string) { await this.friends.remove(await this.owner(request), id); }
}
@Module({ imports: [AuthModule, LibraryModule, MongooseModule.forFeature([{ name: Friendship.name, schema: FriendshipSchema }])], controllers: [FriendsController], providers: [FriendsService] })
export class FriendsModule {}
