import { recordSocialActivity } from '../social/social-store';
import {recordPrivateActivity} from '../library/activity-history';
import { gameStatusEvent } from '../library/game-status-event';
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Connection, Types } from 'mongoose';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config';

export type GameSession = { id: string; playedOn: string; minutes: number; createdAt: Date; updatedAt: Date; requestSignature?: string };
type GameRecord = { ownerId: Types.ObjectId; kind: string; status: string; playtimeMinutes?: number; gameSessionRevision?: number; gameSessions?: GameSession[]; updatedAt?: Date };
export const sessionMinutes = (sessions: GameSession[] = []) => sessions.reduce((sum, session) => sum + session.minutes, 0);
class SessionDateDto {
  @ApiProperty({ example: '2026-11-02', description: 'Dia real em que jogou, sem datas futuras no fuso informado.' })
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) playedOn!: string;
  @ApiProperty({ required: false, default: 'UTC', maxLength: 100, example: 'America/Sao_Paulo' })
  @IsOptional() @IsString() @MaxLength(100) timeZone?: string;
}
class AddSessionDto extends SessionDateDto {
  @ApiProperty({ format: 'uuid', description: 'Chave única gerada pelo cliente. Repetir a mesma solicitação não duplica horas.' })
  @IsUUID() id!: string;
  @ApiProperty({ enum: ['add', 'total'], description: 'add informa a duração; total informa o total após jogar e registra apenas a diferença positiva.' })
  @IsIn(['add', 'total']) mode!: 'add' | 'total';
  @ApiProperty({ minimum: 1, maximum: 6000000, description: 'Minutos inteiros. A duração efetiva da sessão deve ficar entre 1 e 1440 minutos.' })
  @IsInt() @Min(1) @Max(6000000) minutes!: number;
  @ApiProperty({ required: false, minimum: 0, maximum: 6000000, description: 'Obrigatório em total: valor visto antes de jogar, para detectar alteração em outra aba.' })
  @IsOptional() @IsInt() @Min(0) @Max(6000000) expectedTotal?: number;
}
class EditSessionDto extends SessionDateDto {
  @ApiProperty({ minimum: 1, maximum: 1440, description: 'Nova duração desta sessão, sem alterar as demais.' })
  @IsInt() @Min(1) @Max(1440) minutes!: number;
}
class SessionQueryDto {
  @ApiProperty({ required: false, default: 0, minimum: 0, maximum: 10000, description: 'Deslocamento no histórico ordenado por data decrescente. Página de 30 sessões.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000) offset?: number;
}
class SessionViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date' }) playedOn!: string;
  @ApiProperty({ minimum: 1, maximum: 1440 }) minutes!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
class SessionsViewDto {
  @ApiProperty() playtimeMinutes!: number;
  @ApiProperty({ description: 'Tempo anterior sem datas, somado às sessões para formar o total.' }) baselineMinutes!: number;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) lastPlayedOn!: string | null;
  @ApiProperty() sessionCount!: number;
  @ApiProperty({ enum: ['planned', 'active', 'completed'] }) status!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) updatedAt!: string | null;
  @ApiProperty({ type: [SessionViewDto] }) sessions!: SessionViewDto[];
  @ApiProperty({ nullable: true, type: Number }) nextOffset!: number | null;
}
function validateDate(dto: SessionDateDto) {
  let today: string;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: dto.timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    today = ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)!.value).join('-');
  } catch { throw new BadRequestException('Fuso horário inválido.'); }
  const date = new Date(dto.playedOn + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dto.playedOn || dto.playedOn > today) throw new BadRequestException('Informe uma data válida, sem dias futuros.');
}
@Injectable()
export class GameSessionsService {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private games() { return this.connection.collection<GameRecord>('library_items'); }
  private async owned(owner: string, id: string) {
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new NotFoundException('Jogo não encontrado.');
    const item = await this.games().findOne({ _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(owner), kind: 'game' }, { projection: { gameStatusHistory: 0 } });
    if (!item) throw new NotFoundException('Jogo não encontrado.');
    return item;
  }
  private view(item: GameRecord, offset = 0) {
    const sessions = [...(item.gameSessions || [])].sort((a, b) => b.playedOn.localeCompare(a.playedOn) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || a.id.localeCompare(b.id));
    return { playtimeMinutes: item.playtimeMinutes || 0, baselineMinutes: (item.playtimeMinutes || 0) - sessionMinutes(sessions), lastPlayedOn: sessions[0]?.playedOn || null, sessionCount: sessions.length, status: item.status, updatedAt: item.updatedAt || null, sessions: sessions.slice(offset, offset + 30).map(({ id, playedOn, minutes, createdAt, updatedAt }) => ({ id, playedOn, minutes, createdAt, updatedAt })), nextOffset: offset + 30 < sessions.length ? offset + 30 : null };
  }
  async list(owner: string, id: string, offset = 0) { return this.view(await this.owned(owner, id), offset); }
  private async change(owner: string, id: string, mutate: (item: GameRecord, sessions: GameSession[]) => GameSession[]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = await this.owned(owner, id);
      const old = item.gameSessions || [];
      // Horas antigas permanecem como saldo sem data. Alterar uma sessão só altera sua própria contribuição.
      const baseline = (item.playtimeMinutes || 0) - sessionMinutes(old);
      const sessions = mutate(item, old);
      const total = baseline + sessionMinutes(sessions);
      if (sessions.length > 10000) throw new BadRequestException('Limite de 10.000 sessões por jogo atingido.');
      if (total > 6000000 || total < 0 || baseline < 0) throw new BadRequestException('O tempo total ultrapassa o limite permitido.');
      const lastPlayedOn = sessions.reduce<string | null>((latest, row) => !latest || row.playedOn > latest ? row.playedOn : latest, null);
      // Uma única gravação atômica guarda histórico, total e última data; não exige transações MongoDB.
      // A revisão e o total também protegem contra edição simultânea pelo formulário antigo.
      const result = await this.games().findOneAndUpdate({ _id: item._id, ownerId: item.ownerId, kind: 'game', status: item.status, $expr: { $and: [{ $eq: [{ $ifNull: ['$gameSessionRevision', 0] }, item.gameSessionRevision || 0] }, { $eq: [{ $ifNull: ['$playtimeMinutes', 0] }, item.playtimeMinutes || 0] }] } }, {
        $set: { gameSessions: sessions, playtimeMinutes: total, lastPlayedOn, updatedAt: new Date(), ...(sessions.length > old.length && item.status === 'planned' ? { status: 'active' } : {}) },
        // A mesma escrita que inicia o jogo guarda a causa; sessões repetidas não repetem o evento.
        ...(sessions.length > old.length && item.status === 'planned' ? { $push: { gameStatusHistory: gameStatusEvent('status', 'planned', 'active', 'session') } } : {}),
        $inc: { gameSessionRevision: 1 },
      }, { returnDocument: 'after' });
      if (result) {
        await recordPrivateActivity(this.connection,result as any,sessions.length>old.length?'game-session-added':sessions.length<old.length?'game-session-deleted':'game-session-edited',`session-change:${id}:${result.gameSessionRevision}`);
        if (item.status === 'planned' && result.status === 'active') await recordSocialActivity(this.connection, result._id, 'started', `game-session:${id}:${sessions.at(-1)?.id}`);
        return this.view(result);
      }
    }
    throw new ConflictException('O jogo mudou em outra aba. Atualize e tente novamente.');
  }
  async add(owner: string, id: string, dto: AddSessionDto) {
    validateDate(dto);
    const requestSignature = JSON.stringify([dto.mode, dto.minutes, dto.expectedTotal ?? null]);
    return this.change(owner, id, (item, sessions) => {
      const previous = sessions.find(row => row.id === dto.id);
      if (previous) {
        if (previous.playedOn !== dto.playedOn || (previous.requestSignature && previous.requestSignature !== requestSignature) || (dto.mode === 'add' && previous.minutes !== dto.minutes)) throw new ConflictException('Esta sessão já foi registrada com outros valores.');
        return sessions;
      }
      if (dto.mode === 'total' && (dto.expectedTotal === undefined || dto.expectedTotal !== (item.playtimeMinutes || 0))) throw new ConflictException('O total mudou. Atualize antes de informar o novo total.');
      const minutes = dto.mode === 'total' ? dto.minutes - (item.playtimeMinutes || 0) : dto.minutes;
      if (minutes < 1 || minutes > 1440) throw new BadRequestException('A sessão deve ter entre 1 minuto e 24 horas. Para corrigir horas anteriores, ajuste o saldo sem data.');
      const now = new Date();
      return [...sessions, { id: dto.id, playedOn: dto.playedOn, minutes, createdAt: now, updatedAt: now, requestSignature }];
    });
  }
  async edit(owner: string, id: string, sessionId: string, dto: EditSessionDto) {
    validateDate(dto);
    return this.change(owner, id, (_item, sessions) => {
      if (!sessions.some(row => row.id === sessionId)) throw new NotFoundException('Sessão não encontrada.');
      return sessions.map(row => row.id === sessionId ? { ...row, playedOn: dto.playedOn, minutes: dto.minutes, updatedAt: new Date() } : row);
    });
  }
  async remove(owner: string, id: string, sessionId: string) {
    return this.change(owner, id, (_item, sessions) => {
      if (!sessions.some(row => row.id === sessionId)) throw new NotFoundException('Sessão não encontrada.');
      return sessions.filter(row => row.id !== sessionId);
    });
  }
}
@ApiTags('game-sessions') @ApiCookieAuth('session')
@ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
@ApiResponse({ status: 404, description: 'Jogo/sessão inexistente ou de outra conta.' })
@ApiResponse({ status: 400, description: 'Data, duração, fuso ou campos inválidos. Limites: 24h por sessão, 10.000 sessões por jogo, 6.000.000 minutos acumulados.' })
@Controller('library/:id/game-sessions')
class GameSessionsController {
  constructor(private readonly service: GameSessionsService, private readonly auth: AuthService) {}
  private async owner(request: Request) {
    if (request.method !== 'GET' && request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem da requisição não permitida.');
    return (await this.auth.forRequest(request)).id;
  }
  @Get() @ApiOperation({ summary: 'Consultar histórico privado de sessões', description: 'Saldo anterior não recebe datas fictícias. Ordena por dia e criação decrescentes; até 30 sessões por página. Permite múltiplas sessões no mesmo dia.' }) @ApiOkResponse({ type: SessionsViewDto })
  async list(@Req() request: Request, @Param('id') id: string, @Query() query: SessionQueryDto) { return this.service.list(await this.owner(request), id, query.offset); }
  @Post() @ApiOperation({ summary: 'Registrar dia e duração ou diferença do novo total', description: 'id UUID torna reenvios idempotentes. total exige expectedTotal e diferença positiva; correções para baixo pertencem ao saldo anterior ou à edição/exclusão das sessões. Não altera avaliações, plataforma ou conclusão. Se o jogo estava planejado, passa a ativo e registra esse início no histórico de status com a data do registro atual.' }) @ApiResponse({ status: 201, type: SessionsViewDto }) @ApiResponse({ status: 409, description: 'Total mudou ou chave já usada com outros dados.' }) @ApiResponse({ status: 403, description: 'Origem não permitida.' })
  async add(@Req() request: Request, @Param('id') id: string, @Body() dto: AddSessionDto) { return this.service.add(await this.owner(request), id, dto); }
  @Patch(':sessionId') @ApiOperation({ summary: 'Editar data e duração de uma sessão', description: 'Recalcula o total e a última data. Preserva o saldo anterior e as demais sessões.' }) @ApiOkResponse({ type: SessionsViewDto }) @ApiResponse({ status: 409, description: 'Jogo alterado simultaneamente.' }) @ApiResponse({ status: 403, description: 'Origem não permitida.' })
  async edit(@Req() request: Request, @Param('id') id: string, @Param('sessionId') sessionId: string, @Body() dto: EditSessionDto) { return this.service.edit(await this.owner(request), id, sessionId, dto); }
  @Delete(':sessionId') @ApiOperation({ summary: 'Excluir uma sessão e descontar sua duração', description: 'Não remove outras sessões ou o saldo sem data. Recalcula a última vez jogada. XP já reconhecido permanece conforme a regra geral.' }) @ApiOkResponse({ type: SessionsViewDto }) @ApiResponse({ status: 409, description: 'Jogo alterado simultaneamente.' }) @ApiResponse({ status: 403, description: 'Origem não permitida.' })
  async remove(@Req() request: Request, @Param('id') id: string, @Param('sessionId') sessionId: string) { return this.service.remove(await this.owner(request), id, sessionId); }
}
@Module({ imports: [AuthModule], providers: [GameSessionsService], controllers: [GameSessionsController] })
export class GameSessionsModule {}
