import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, OnModuleInit, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiCookieAuth, ApiOperation, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
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
  @ApiProperty({ type: [String], maxItems: 100, description: 'IDs próprios da biblioteca, em ordem; qualquer status. Sem repetir a mesma obra. A lista guarda somente metadados do título, nunca progresso ou anotações.' })
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
type Entry = { sourceId: string; key: string; title: string; kind: string; coverUrl: string; year: string };
type List = { _id: Types.ObjectId; ownerId: Types.ObjectId; name: string; description: string; visibility: 'private' | 'friends'; entries: Entry[]; requestId: string; revision: number; createdAt: Date; updatedAt: Date };
@Injectable()
class ListsService implements OnModuleInit {
  constructor(@InjectConnection() private readonly db: Connection) {}
  private rows() { return this.db.collection<List>('social_lists'); }
  async onModuleInit() {
    await this.rows().createIndex({ ownerId: 1, requestId: 1 }, { unique: true });
    await this.rows().createIndex({ ownerId: 1, visibility: 1, _id: -1 });
  }
  private id(value: string) { if (!/^[a-f0-9]{24}$/i.test(value)) throw new BadRequestException('Identificador inválido.'); return new Types.ObjectId(value); }
  private async friends(owner: string) {
    const links = await this.db.collection('friendships').find({ status: 'accepted', $or: [{ sender: owner }, { receiver: owner }] }).toArray();
    return links.map(row => this.id(row.sender === owner ? row.receiver : row.sender));
  }
  private async owned(owner: string, id: string) {
    const row = await this.rows().findOne({ _id: this.id(id), ownerId: this.id(owner) });
    if (!row) throw new NotFoundException('Lista não encontrada.');
    return row;
  }
  private async entries(owner: string, ids: string[], previous: Entry[] = []) {
    const rows = await this.db.collection('library_items').find({ ownerId: this.id(owner), _id: { $in: ids.map(id => this.id(id)) } }).toArray();
    const entries = ids.map(id => {
      const row = rows.find(row => row._id.toString() === id);
      // Uma lista é uma curadoria independente: excluir o acompanhamento não apaga o título compartilhado.
      // Só se reutilizam metadados já escolhidos pelo próprio dono, nunca IDs de outra conta.
      const old = previous.find(entry => entry.sourceId === id);
      if (!row && !old) throw new BadRequestException('Escolha títulos da sua biblioteca.');
      return row ? { sourceId: id, key: row.catalogKey || id, title: row.title, kind: row.kind, coverUrl: row.coverUrl || '', year: row.year || '' } : old!;
    });
    if (new Set(entries.map(entry => entry.key)).size !== entries.length) throw new BadRequestException('A mesma obra não pode aparecer duas vezes na lista.');
    return entries;
  }
  private async result(owner: string, row: List, full = true) {
    const mine = row.ownerId.toString() === owner;
    const user = await this.db.collection('users').findOne({ _id: row.ownerId }, { projection: { displayName: 1 } });
    return { id: row._id.toString(), mine, name: row.name, description: row.description, visibility: row.visibility, revision: row.revision, ownerName: user?.displayName || 'Player', count: row.entries.length, updatedAt: row.updatedAt,
      ...(full ? { entries: row.entries.map(({ sourceId, ...entry }) => ({ ...entry, ...(mine ? { sourceId } : {}) })) } : { covers: row.entries.slice(0, 4).map(entry => entry.coverUrl) }) };
  }
  async index(owner: string, scope = 'mine', before?: string) {
    if (!['mine', 'friends'].includes(scope)) throw new BadRequestException('Filtro inválido.');
    const boundary = before ? this.id(before) : null;
    const filter = scope === 'mine' ? { ownerId: this.id(owner) } : { ownerId: { $in: await this.friends(owner) }, visibility: 'friends' as const };
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
    const previous = await this.owned(owner, id);
    const changes = { name: dto.name, description: dto.description, visibility: dto.visibility, entries: await this.entries(owner, dto.itemIds, previous.entries), updatedAt: new Date() };
    const row = await this.rows().findOneAndUpdate({ _id: previous._id, ownerId: previous.ownerId, revision: dto.revision }, { $set: changes, $inc: { revision: 1 } }, { returnDocument: 'after' });
    if (!row) throw new ConflictException('A lista mudou. Atualize antes de editar novamente.');
    return this.result(owner, row);
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
  @ApiQuery({ name: 'scope', required: false, enum: ['mine', 'friends'] }) @ApiQuery({ name: 'before', required: false, type: String })
  async index(@Req() req: Request, @Query('scope') scope?: string, @Query('before') before?: string) { return this.service.index(await this.owner(req), scope, before); }
  @Get(':id') @ApiOperation({ summary: 'Abrir lista compartilhada por link', description: 'Exige sessão do dono ou amigo atualmente aceito quando visibility=friends; demais recebem 404. Retorna metadados escolhidos, nunca avaliações, progresso ou anotações. sourceId só aparece ao dono. Arquivar/excluir o acompanhamento não remove a curadoria; remova o título da lista para deixar de compartilhá-lo.' })
  async get(@Req() req: Request, @Param('id') id: string) { return this.service.get(await this.owner(req), id); }
  @Post() @ApiOperation({ summary: 'Criar lista personalizada', description: 'Até 100 títulos próprios de qualquer status, ordenados, sem repetir obra. requestId UUID evita duplicação em reenvios; dados diferentes com a mesma chave retornam 409. Não altera biblioteca, XP ou status de consumo.' })
  async create(@Req() req: Request, @Body() dto: CreateList) { return this.service.create(await this.owner(req), dto); }
  @Patch(':id') @ApiOperation({ summary: 'Editar nome, descrição, acesso e ordem dos títulos', description: 'Somente dono. Envie todos os campos e a revision atual. Conflito de revisão retorna 409. Compartilhamento independe do perfil/feed; mudar para private revoga acesso dos amigos.' })
  async edit(@Req() req: Request, @Param('id') id: string, @Body() dto: EditList) { return this.service.edit(await this.owner(req), id, dto); }
  @Delete(':id') @HttpCode(204) @ApiOperation({ summary: 'Excluir lista própria', description: 'Exige revision atual no corpo; não exclui títulos da biblioteca. Links deixam de funcionar.' })
  async remove(@Req() req: Request, @Param('id') id: string, @Body() dto: DeleteList) { return this.service.remove(await this.owner(req), id, dto.revision); }
}
@Module({ imports: [AuthModule], controllers: [ListsController], providers: [ListsService] })
export class ListsModule {}
