import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, OnModuleInit, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiCookieAuth, ApiOperation, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { createHash } from 'node:crypto';
import { Transform } from 'class-transformer';
import { Connection, Types } from 'mongoose';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config';

class ListFields {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ maxLength: 1000 })
  @IsString() @MaxLength(1000) description!: string;
  @ApiProperty({ enum: ['private', 'friends'], description: 'private: só o dono; friends: dono e amigos atualmente aceitos, inclusive por link. Independente do perfil e do feed.' })
  @IsIn(['private', 'friends']) visibility!: 'private' | 'friends';
  @ApiProperty({ type: [String], maxItems: 100, description: 'Em ordem: entryId existente ou ID próprio da biblioteca para adicionar; qualquer status. Até 100 obras distintas. Não aceita IDs de bibliotecas alheias nem expõe notas/progresso.' })
  @IsArray() @ArrayMaxSize(100) @ArrayUnique() @Matches(/^[a-f0-9]{24}$/, { each: true }) itemIds!: string[];
}
class CreateList extends ListFields {
  @ApiProperty({ format: 'uuid', description: 'Chave de reenvio, única por conta. Repetir com outros dados retorna 409.' })
  @IsUUID() requestId!: string;
}
class EditList extends ListFields {
  @ApiProperty({ minimum: 0, description: 'Revisão lida; edição concorrente retorna 409.' })
  @IsInt() @Min(0) revision!: number;
}
class DeleteList {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) revision!: number;
}
class CollaborationDto extends DeleteList {
  @ApiProperty({ enum: ['invite', 'remove', 'accept', 'decline', 'leave'], description: 'Dono: invite/remove com userId. Convidado: accept/decline/leave sobre si mesmo. Exige revision atual.' })
  @IsIn(['invite', 'remove', 'accept', 'decline', 'leave']) action!: 'invite' | 'remove' | 'accept' | 'decline' | 'leave';
  @ApiProperty({ required: false, description: 'Obrigatório em invite/remove; não permitido nas ações do convidado.' })
  @ValidateIf((_o, value) => value !== undefined) @Matches(/^[a-f0-9]{24}$/) userId?: string;
}
type Entry = { entryId?: string; sourceOwner?: string; sourceId: string; key: string; title: string; kind: string; coverUrl: string; year: string };
type Collaborator = { userId: string; friendshipId: string; status: 'pending' | 'accepted' };
type List = { _id: Types.ObjectId; ownerId: Types.ObjectId; name: string; description: string; visibility: 'private' | 'friends'; entries: Entry[]; collaborators?: Collaborator[]; requestId: string; revision: number; createdAt: Date; updatedAt: Date };
@Injectable()
class ListsService implements OnModuleInit {
  constructor(@InjectConnection() private readonly db: Connection) {}
  private rows() { return this.db.collection<List>('social_lists'); }
  async onModuleInit() {
    await this.rows().createIndex({ ownerId: 1, requestId: 1 }, { unique: true });
    await this.rows().createIndex({ ownerId: 1, visibility: 1, _id: -1 });
    await this.rows().createIndex({ 'collaborators.userId': 1, _id: -1 });
  }
  private id(value: string) { if (!/^[a-f0-9]{24}$/i.test(value)) throw new BadRequestException('Identificador inválido.'); return new Types.ObjectId(value); }
  private async friends(owner: string) {
    const links = await this.db.collection('friendships').find({ status: 'accepted', $or: [{ sender: owner }, { receiver: owner }] }).toArray();
    return links.map(row => this.id(row.sender === owner ? row.receiver : row.sender));
  }
  private async links(owner: string) {
    return this.db.collection('friendships').find({ status: 'accepted', $or: [{ sender: owner }, { receiver: owner }] }).toArray();
  }
  private async membership(viewer: string, row: List) {
    if (row.ownerId.toString() === viewer) return 'owner' as const;
    if (row.visibility !== 'friends') return 'viewer' as const;
    const links = await this.links(viewer);
    const member = row.collaborators?.find(member => member.userId === viewer && links.some(link => link._id.toString() === member.friendshipId && (link.sender === row.ownerId.toString() || link.receiver === row.ownerId.toString())));
    return member?.status === 'accepted' ? 'editor' as const : member ? 'invited' as const : 'viewer' as const;
  }
  private normalized(row: List) {
    // IDs estáveis de entradas legadas dispensam migração e não expõem os IDs privados de origem.
    return row.entries.map(entry => ({ ...entry, entryId: entry.entryId || createHash('sha256').update(row._id.toString() + ':' + entry.sourceId).digest('hex').slice(0, 24), sourceOwner: entry.sourceOwner || row.ownerId.toString() }));
  }
  private async owned(owner: string, id: string) {
    const row = await this.rows().findOne({ _id: this.id(id), ownerId: this.id(owner) });
    if (!row) throw new NotFoundException('Lista não encontrada.');
    return row;
  }
  private async entries(owner: string, ids: string[], previous: Entry[] = []) {
    const rows = await this.db.collection('library_items').find({ ownerId: this.id(owner), _id: { $in: ids.map(id => this.id(id)) } }).toArray();
    const entries = ids.map(id => {
      const old = previous.find(entry => entry.entryId === id || (entry.sourceOwner === owner && entry.sourceId === id));
      if (old) return old;
      const row = rows.find(row => row._id.toString() === id);
      // Uma lista é uma curadoria independente: excluir o acompanhamento não apaga o título compartilhado.
      // Cada participante acrescenta apenas obras próprias; entradas já compartilhadas usam entryId.
      if (!row) throw new BadRequestException('Escolha títulos da sua biblioteca.');
      return { entryId: new Types.ObjectId().toString(), sourceOwner: owner, sourceId: id, key: row.catalogKey || id, title: row.title, kind: row.kind, coverUrl: row.coverUrl || '', year: row.year || '' };
    });
    if (new Set(entries.map(entry => entry.key)).size !== entries.length) throw new BadRequestException('A mesma obra não pode aparecer duas vezes na lista.');
    return entries;
  }
  private async result(owner: string, row: List, full = true) {
    const mine = row.ownerId.toString() === owner;
    const role = await this.membership(owner, row);
    const user = await this.db.collection('users').findOne({ _id: row.ownerId }, { projection: { displayName: 1 } });
    let collaboration = {};
    if (full && mine) {
      const links = await this.links(owner);
      const users = await this.db.collection('users').find({ _id: { $in: links.map(link => this.id(link.sender === owner ? link.receiver : link.sender)) } }, { projection: { displayName: 1 } }).toArray();
      collaboration = { friends: users.map(user => ({ id: user._id.toString(), name: user.displayName || 'Player' })), collaborators: (row.collaborators || []).filter(member => links.some(link => link._id.toString() === member.friendshipId)).map(member => ({ id: member.userId, name: users.find(user => user._id.toString() === member.userId)?.displayName || 'Player', status: member.status })) };
    }
    return { id: row._id.toString(), mine, role, canEdit: role === 'owner' || role === 'editor', name: row.name, description: row.description, visibility: row.visibility, revision: row.revision, ownerName: user?.displayName || 'Player', count: row.entries.length, updatedAt: row.updatedAt, ...collaboration,
      ...(full ? { entries: this.normalized(row).map(({ sourceId, sourceOwner, ...entry }) => ({ ...entry, ...(sourceOwner === owner ? { sourceId } : {}) })) } : { covers: row.entries.slice(0, 4).map(entry => entry.coverUrl) }) };
  }
  async index(owner: string, scope = 'mine', before?: string) {
    if (!['mine', 'friends', 'collaborations'].includes(scope)) throw new BadRequestException('Filtro inválido.');
    const boundary = before ? this.id(before) : null;
    const links = scope === 'collaborations' ? await this.links(owner) : [];
    const filter = scope === 'mine' ? { ownerId: this.id(owner) } : { ownerId: { $in: await this.friends(owner) }, visibility: 'friends' as const, ...(scope === 'collaborations' ? { collaborators: { $elemMatch: { userId: owner, friendshipId: { $in: links.map(link => link._id.toString()) } } } } : {}) };
    const rows = await this.rows().find({ ...filter, ...(boundary ? { _id: { $lt: boundary } } : {}) }).sort({ _id: -1 }).limit(31).toArray();
    return { lists: await Promise.all(rows.slice(0, 30).map(row => this.result(owner, row, false))), nextBefore: rows.length > 30 ? rows[29]._id.toString() : null };
  }
  async get(owner: string, id: string) {
    const row = await this.rows().findOne({ _id: this.id(id) });
    if (!row || (row.ownerId.toString() !== owner && (row.visibility !== 'friends' || !(await this.friends(owner)).some(id => id.equals(row.ownerId))))) throw new NotFoundException('Lista privada ou não encontrada.');
    return this.result(owner, row);
  }
  async create(owner: string, dto: CreateList) {
    const ownerId = this.id(owner);
    const prior = await this.rows().findOne({ ownerId, requestId: dto.requestId });
    const same = (row: List) => row.name === dto.name && row.description === dto.description && row.visibility === dto.visibility && JSON.stringify(row.entries.map(entry => entry.sourceId)) === JSON.stringify(dto.itemIds);
    if (prior) { if (!same(prior)) throw new ConflictException('Este envio já criou outra lista.'); return this.result(owner, prior); }
    const now = new Date();
    const row: List = { _id: new Types.ObjectId(), ownerId, name: dto.name, description: dto.description, visibility: dto.visibility, entries: await this.entries(owner, dto.itemIds), requestId: dto.requestId, revision: 0, createdAt: now, updatedAt: now };
    try { await this.rows().insertOne(row); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const saved = await this.rows().findOne({ ownerId, requestId: dto.requestId });
      if (!saved || !same(saved)) throw new ConflictException('Este envio já criou outra lista.');
      return this.result(owner, saved);
    }
    return this.result(owner, row);
  }
  async edit(owner: string, id: string, dto: EditList) {
    const previous = await this.rows().findOne({ _id: this.id(id) });
    if (!previous) throw new NotFoundException('Lista não encontrada.');
    const role = await this.membership(owner, previous);
    if (role !== 'owner' && role !== 'editor') throw new NotFoundException('Lista não encontrada ou sem permissão de edição.');
    if (role !== 'owner' && dto.visibility !== previous.visibility) throw new ForbiddenException('Somente o dono pode alterar a privacidade.');
    // A revisão inclui convites/revogações, impedindo que uma tela antiga restaure permissões.
    const changes = { name: dto.name, description: dto.description, visibility: dto.visibility, ...(dto.visibility === 'private' ? { collaborators: [] } : {}), entries: await this.entries(owner, dto.itemIds, this.normalized(previous)), updatedAt: new Date() };
    const row = await this.rows().findOneAndUpdate({ _id: previous._id, ownerId: previous.ownerId, revision: dto.revision }, { $set: changes, $inc: { revision: 1 } }, { returnDocument: 'after' });
    if (!row) throw new ConflictException('A lista mudou. Atualize antes de editar novamente.');
    return this.result(owner, row);
  }
  async collaborate(viewer: string, id: string, dto: CollaborationDto) {
    const row = await this.rows().findOne({ _id: this.id(id) });
    if (!row) throw new NotFoundException('Lista não encontrada.');
    const own = row.ownerId.toString() === viewer;
    if (row.visibility !== 'friends') throw new BadRequestException('Compartilhe a lista com amigos antes de convidar colaboradores.');
    const links = await this.links(row.ownerId.toString());
    // A autorização fica vinculada à amizade atual: refazer amizade exige novo convite.
    let next = (row.collaborators || []).filter(member => links.some(link => link._id.toString() === member.friendshipId));
    if (dto.action === 'invite' || dto.action === 'remove') {
      if (!own) throw new ForbiddenException('Somente o dono pode gerenciar colaboradores.');
      if (!dto.userId || dto.userId === viewer) throw new BadRequestException('Escolha um amigo aceito.');
      const link = links.find(link => link.sender === dto.userId || link.receiver === dto.userId);
      if (!link) throw new BadRequestException('Escolha um amigo aceito.');
      if (dto.action === 'remove') next = next.filter(member => member.userId !== dto.userId);
      else if (!next.some(member => member.userId === dto.userId)) {
        if (next.length >= 20) throw new BadRequestException('A lista permite até 20 colaboradores.');
        next.push({ userId: dto.userId, friendshipId: link._id.toString(), status: 'pending' });
      }
    } else {
      if (own || dto.userId !== undefined) throw new BadRequestException('Esta ação deve ser feita pelo próprio convidado.');
      if (!next.some(member => member.userId === viewer)) throw new NotFoundException('Convite não encontrado.');
      if (dto.action === 'accept') next = next.map(member => member.userId === viewer ? { ...member, status: 'accepted' } : member);
      else next = next.filter(member => member.userId !== viewer);
    }
    const updated = await this.rows().findOneAndUpdate({ _id: row._id, revision: dto.revision }, { $set: { collaborators: next, updatedAt: new Date() }, $inc: { revision: 1 } }, { returnDocument: 'after' });
    if (!updated) throw new ConflictException('A lista mudou. Atualize antes de tentar novamente.');
    return this.result(viewer, updated);
  }
  async remove(owner: string, id: string, revision: number) {
    const row = await this.owned(owner, id);
    if (!(await this.rows().deleteOne({ _id: row._id, ownerId: row.ownerId, revision })).deletedCount) throw new ConflictException('A lista mudou. Atualize antes de excluir.');
  }
}
@ApiTags('listas') @ApiCookieAuth('session') @Controller('lists')
class ListsController {
  constructor(private readonly service: ListsService, private readonly auth: AuthService) {}
  private async owner(request: Request) { if (request.method !== 'GET' && request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem não permitida.'); return (await this.auth.forRequest(request)).id; }
  @Get() @ApiOperation({ summary: 'Listas próprias ou compartilhadas por amigos', description: 'Até 30 por página, ordem de criação decrescente. Exige sessão. Amigos pendentes não recebem acesso.' })
  @ApiQuery({ name: 'scope', required: false, enum: ['mine', 'friends', 'collaborations'] }) @ApiQuery({ name: 'before', required: false, type: String })
  async index(@Req() req: Request, @Query('scope') scope?: string, @Query('before') before?: string) { return this.service.index(await this.owner(req), scope, before); }
  @Get(':id') @ApiOperation({ summary: 'Abrir lista compartilhada por link', description: 'Exige sessão do dono ou amigo atualmente aceito quando visibility=friends; demais recebem 404. Retorna metadados escolhidos, nunca avaliações, progresso ou anotações. entryId identifica a entrada; sourceId só aparece ao dono da biblioteca de origem. role=owner/editor/invited/viewer e canEdit indicam permissões. Só o dono recebe friends elegíveis e collaborators (id/name/status). Arquivar/excluir o acompanhamento não remove a curadoria; remova o título da lista para deixar de compartilhá-lo.' })
  async get(@Req() req: Request, @Param('id') id: string) { return this.service.get(await this.owner(req), id); }
  @Post() @ApiOperation({ summary: 'Criar lista personalizada', description: 'Até 100 títulos próprios de qualquer status, ordenados, sem repetir obra. requestId UUID evita duplicação em reenvios; dados diferentes com a mesma chave retornam 409. Não altera biblioteca, XP ou status de consumo.' })
  async create(@Req() req: Request, @Body() dto: CreateList) { return this.service.create(await this.owner(req), dto); }
  @Patch(':id') @ApiOperation({ summary: 'Editar nome, descrição, acesso e ordem dos títulos', description: 'Dono e editor aceito alteram nome/descrição e títulos ordenados, usando entryId existente ou ID próprio para novas entradas em itemIds. Só dono altera visibility (403 para editor); private limpa convites e colaboradores. Exige revision atual, 409 em conflito. Não altera biblioteca ou XP.' })
  async edit(@Req() req: Request, @Param('id') id: string, @Body() dto: EditList) { return this.service.edit(await this.owner(req), id, dto); }
  @Patch(':id/collaboration') @ApiOperation({ summary: 'Convidar/remover editor ou responder convite', description: 'Exige revision atual (409 em conflito). Até 20 colaboradores, amigos aceitos do dono, visibility=friends. invite/remove: só dono com userId. accept/decline/leave: próprio convidado sem userId. Convite pendente não concede edição. Desfazer amizade invalida a colaboração, mesmo após refazê-la. scope=collaborations lista convites e participações válidas.' })
  async collaborate(@Req() req: Request, @Param('id') id: string, @Body() dto: CollaborationDto) { return this.service.collaborate(await this.owner(req), id, dto); }
  @Delete(':id') @HttpCode(204) @ApiOperation({ summary: 'Excluir lista própria', description: 'Exige revision atual no corpo; não exclui títulos da biblioteca. Links deixam de funcionar.' })
  async remove(@Req() req: Request, @Param('id') id: string, @Body() dto: DeleteList) { return this.service.remove(await this.owner(req), id, dto.revision); }
}
@Module({ imports: [AuthModule], controllers: [ListsController], providers: [ListsService] })
export class ListsModule {}
