import { BadRequestException, ConflictException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ApiCookieAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Model, Types } from 'mongoose';
import type { Request, Response } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { CatalogModule, CatalogService } from '../catalog/catalog.module';
import { BooksModule, BooksService } from '../books/books.module';
import { getConfig } from '../config';
import { CollectorPhotoStorage, collectorPhotoBuffer } from './collector-photo-storage';
import { CollectorCopiesResultDto, CollectorCopyDto, CollectorCopyResultDto, collectorKinds, copyFormats } from './collector.dto';

// Cada documento representa uma cópia. Não há índice único por obra/edição:
// o colecionador pode possuir duas cópias idênticas, sem duplicar o acompanhamento.
@Schema({ collection: 'collector_copies', timestamps: true })
export class CollectorCopy {
  @Prop({ type: Types.ObjectId, required: true }) ownerId!: Types.ObjectId;
  @Prop({ required: true, maxlength: 200 }) title!: string;
  @Prop({ required: true, enum: collectorKinds }) kind!: string;
  @Prop({ required: true, enum: copyFormats }) format!: string;
  @Prop({ default: '', maxlength: 100 }) platform!: string;
  @Prop({ default: '', maxlength: 150 }) edition!: string;
  @Prop({ default: '', maxlength: 2000 }) notes!: string;
  @Prop({ default: '', maxlength: 60 }) category!: string;
  @Prop({ default: '' }) photoKey!: string;
  @Prop() catalogId?: string;
  @Prop() coverUrl?: string;
  @Prop() year?: string;
  @Prop({ type: [String], default: [] }) authors!: string[];
  @Prop({ default: '' }) isbn!: string;
  @Prop({ default: '' }) publisher!: string;
  @Prop({ default: '' }) language!: string;
  @Prop({ type: [String], default: [] }) genres!: string[];
  @Prop({ default: 0 }) bookMetadataVersion!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
const schema = SchemaFactory.createForClass(CollectorCopy);
schema.index({ ownerId: 1, updatedAt: -1, _id: -1 });

@Injectable()
export class CollectorService {
  constructor(@InjectModel(CollectorCopy.name) private readonly copies: Model<CollectorCopy>, private readonly catalog: CatalogService, private readonly books: BooksService, private readonly photos: CollectorPhotoStorage) {}
  private scope(ownerId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Cópia não encontrada.');
    return { _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(ownerId) };
  }
  private publicCopy(copy: CollectorCopy & { _id: Types.ObjectId }) {
    // ownerId e quaisquer dados de sessão nunca fazem parte da resposta pública.
    return { id: copy._id.toString(), title: copy.title, kind: copy.kind, format: copy.format,
      category: copy.category || '',
      platform: copy.platform, edition: copy.edition, notes: copy.notes, catalogId: copy.catalogId,
      coverUrl: copy.kind === 'other' ? copy.photoKey ? `/api/collector/copies/${copy._id}/photo?v=${encodeURIComponent(copy.updatedAt.toISOString())}` : '' : copy.coverUrl, year: copy.year, authors: copy.authors || [], isbn: copy.isbn || '',
      publisher: copy.publisher || '', language: copy.language || '', genres: copy.genres || [], createdAt: copy.createdAt, updatedAt: copy.updatedAt };
  }
  async list(ownerId: string) {
    const copies = await this.copies.find({ ownerId: new Types.ObjectId(ownerId) }).sort({ updatedAt: -1, _id: -1 }).lean().exec();
    return { copies: copies.map(copy => this.publicCopy(copy)) };
  }
  async save(ownerId: string, dto: CollectorCopyDto, id?: string, language = 'pt-BR') {
    const previous = id ? await this.copies.findOne(this.scope(ownerId, id)).lean().exec() : null;
    if (id && !previous) throw new NotFoundException('Cópia não encontrada.');
    if (dto.kind === 'other' && dto.catalogId) throw new BadRequestException('Objetos são cadastrados manualmente, sem catálogo.');
    if (dto.kind !== 'other' && (dto.category || dto.photo !== undefined)) throw new BadRequestException('Categoria personalizada e foto são exclusivas de Outros.');
    if (dto.kind === 'other' && !dto.category?.trim()) throw new BadRequestException('Informe a categoria do objeto.');
    if (dto.kind === 'other' && dto.format !== 'physical') throw new BadRequestException('Objetos da coleção usam formato físico.');
    const image = dto.photo ? collectorPhotoBuffer(dto.photo) : undefined;
    if (dto.catalogId && !dto.catalogId.startsWith(`${dto.kind === 'book' ? 'googlebooks' : dto.kind === 'game' ? 'igdb' : 'tmdb'}:${dto.kind}:`)) throw new BadRequestException('A categoria não corresponde à referência de catálogo.');
    // Metadados externos são resolvidos somente quando muda a referência. Editar uma
    // edição existente não depende de disponibilidade do provedor nem grava library_items.
    const metadata = dto.catalogId
      ? previous?.catalogId === dto.catalogId ? previous : dto.kind === 'book' ? await this.books.detail(dto.catalogId) : await this.catalog.detail(dto.catalogId, language)
      : null;
    // A edição/ISBN é validada no servidor. O cliente só envia a referência do volume;
    // duas cópias da mesma edição continuam com IDs de posse independentes.
    const book = dto.kind === 'book' && metadata && 'authors' in metadata ? metadata as { authors?: string[]; isbn?: string; publisher?: string; language?: string; genres?: string[] } : null;
    const uploadedKey = image ? await this.photos.upload(ownerId, image) : undefined;
    const photoKey = dto.kind !== 'other' || dto.photo === '' ? '' : uploadedKey || previous?.photoKey || '';
    const values = { category: dto.kind === 'other' ? dto.category!.trim() : '', photoKey, title: metadata?.title || dto.title, kind: dto.kind, format: dto.format,
      platform: dto.kind === 'other' ? '' : dto.platform || '', edition: dto.kind === 'other' ? '' : dto.edition || '', notes: dto.notes || '',
      catalogId: dto.catalogId || '', coverUrl: metadata?.coverUrl || '', year: metadata?.year || '',
      authors: book?.authors || [], isbn: book?.isbn || '', publisher: book?.publisher || '', language: book?.language || '', genres: book?.genres || [],
      bookMetadataVersion: dto.kind === 'book' && dto.catalogId ? previous?.catalogId === dto.catalogId ? previous.bookMetadataVersion || 0 : 1 : 0 };
    try {
      // A versão impede que duas edições simultâneas sobrescrevam a foto e deixem arquivos órfãos.
      const version = previous && (previous as { __v?: number }).__v;
      const copy = id
        ? await this.copies.findOneAndUpdate({ ...this.scope(ownerId, id), __v: version === undefined ? { $exists: false } : version }, { $set: values, $inc: { __v: 1 } }, { returnDocument: 'after', runValidators: true }).lean().exec()
        : await this.copies.create({ ...values, ownerId: new Types.ObjectId(ownerId) });
      if (!copy) throw new ConflictException('O exemplar foi alterado. Atualize a coleção e tente novamente.');
      if (previous?.photoKey && previous.photoKey !== photoKey) await this.photos.remove(previous.photoKey);
      return { copy: this.publicCopy(copy) };
    } catch (error) {
      if (uploadedKey) await this.photos.remove(uploadedKey);
      throw error;
    }
  }
  async photo(ownerId: string, id: string) {
    const copy = await this.copies.findOne(this.scope(ownerId, id)).lean().exec();
    if (!copy?.photoKey || copy.kind !== 'other') throw new NotFoundException('Foto não encontrada.');
    return this.photos.signedUrl(copy.photoKey);
  }
  async remove(ownerId: string, id: string) {
    const copy = await this.copies.findOneAndDelete(this.scope(ownerId, id));
    if (!copy) throw new NotFoundException('Cópia não encontrada.');
    if (copy.photoKey) await this.photos.remove(copy.photoKey);
  }
}

@ApiTags('collector')
@ApiCookieAuth('session')
@ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
@ApiResponse({ status: 403, description: 'Mutações exigem Origin igual a CLIENT_ORIGIN.' })
@Controller('collector/copies')
export class CollectorController {
  constructor(private readonly collector: CollectorService, private readonly auth: AuthService) {}
  private async user(request: Request) {
    if (request.method !== 'GET' && request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem da requisição não permitida.');
    const token: unknown = request.cookies?.[getConfig().cookieName];
    return this.auth.me(typeof token === 'string' ? token : undefined);
  }
  @Get()
  @ApiOperation({ summary: 'Listar cópias do acervo privado', description: 'Somente bens possuídos. Não inclui nem modifica acompanhamento, progresso ou avaliações.' })
  @ApiOkResponse({ type: CollectorCopiesResultDto })
  async list(@Req() request: Request) { return this.collector.list((await this.user(request)).id); }
  @Get(':id/photo')
  @ApiParam({ name: 'id', description: 'ID do exemplar pertencente à sessão.' })
  @ApiOperation({ summary: 'Acessar foto privada de um objeto da coleção', description: 'Verifica o dono e redireciona para URL S3 assinada por 5 minutos. Não expõe a chave na listagem.' })
  @ApiResponse({ status: 302, description: 'Redirecionamento temporário para JPEG privado no S3.' })
  @ApiResponse({ status: 404, description: 'Exemplar/foto ausente ou de outro usuário.' })
  @ApiResponse({ status: 503, description: 'Armazenamento indisponível.' })
  async photo(@Req() request: Request, @Param('id') id: string, @Res() response: Response) {
    response.redirect(302, await this.collector.photo((await this.user(request)).id, id));
  }
  @Post()
  @ApiOperation({ summary: 'Adicionar uma cópia possuída', description: 'Aceita várias cópias da mesma obra, inclusive mesma edição/plataforma. Não cria título no acompanhamento. Livros aceitam Google Books ou cadastro manual. Metadados e ISBN são resolvidos pelo servidor. kind=other é manual, exige category e aceita photo JPEG opcional no S3 privado. Omitir photo preserva a foto; vazio remove. Objetos não entram no acompanhamento.' })
  @ApiCreatedResponse({ type: CollectorCopyResultDto })
  @ApiResponse({ status: 503, description: 'S3 indisponível; o exemplar não é gravado quando o upload falha.' })
  @ApiResponse({ status: 400, description: 'Campos inválidos ou categoria incompatível com o catálogo.' })
  async create(@Req() request: Request, @Body() dto: CollectorCopyDto) { const user = await this.user(request); return this.collector.save(user.id, dto, undefined, user.language); }
  @Patch(':id')
  @ApiParam({ name: 'id', description: 'ID da cópia, não o ID da obra no catálogo.' })
  @ApiOperation({ summary: 'Editar os dados de uma cópia', description: 'Enviar título, categoria e formato; campos opcionais omitidos ficam vazios, exceto photo que preserva o arquivo. Para other, category é obrigatória. Outras cópias não são alteradas.' })
  @ApiResponse({ status: 409, description: 'Edição simultânea; recarregue a coleção.' })
  @ApiResponse({ status: 503, description: 'Armazenamento indisponível.' })
  @ApiOkResponse({ type: CollectorCopyResultDto })
  @ApiResponse({ status: 400, description: 'Campos inválidos ou categoria incompatível com o catálogo.' })
  @ApiResponse({ status: 404, description: 'Cópia não encontrada ou de outro usuário.' })
  async update(@Req() request: Request, @Param('id') id: string, @Body() dto: CollectorCopyDto) { const user = await this.user(request); return this.collector.save(user.id, dto, id, user.language); }
  @Delete(':id') @HttpCode(204)
  @ApiParam({ name: 'id', description: 'ID da cópia a remover.' })
  @ApiOperation({ summary: 'Remover somente uma cópia', description: 'Não remove outras cópias nem o título do acompanhamento.' })
  @ApiNoContentResponse()
  @ApiResponse({ status: 404, description: 'Cópia não encontrada ou de outro usuário.' })
  async remove(@Req() request: Request, @Param('id') id: string) { await this.collector.remove((await this.user(request)).id, id); }
}

@Module({ imports: [AuthModule, CatalogModule, BooksModule, MongooseModule.forFeature([{ name: CollectorCopy.name, schema }])], providers: [CollectorService, CollectorPhotoStorage], controllers: [CollectorController] })
export class CollectorModule {}
