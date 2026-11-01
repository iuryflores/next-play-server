import { BadGatewayException, BadRequestException, Controller, Get, HttpException, Injectable, Module, NotFoundException, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { alreadyOwned, bookAffinity, bookPreferences, type OwnedBook } from './book-recommendations';
import { BookSearchDto, BookSearchResultDto, BookSuggestionsDto, BookTitleDto } from './books.dto';

type Volume = { id?: string; volumeInfo?: { title?: string; categories?: string[]; authors?: string[]; industryIdentifiers?: { type?: string; identifier?: string }[]; publisher?: string; language?: string; publishedDate?: string; description?: string; imageLinks?: { thumbnail?: string; smallThumbnail?: string } } };
const volumeId = /^[A-Za-z0-9_-]{1,100}$/;
const clean = (value: unknown, max = 200) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim().slice(0, max) : '';

// Valida o dígito verificador: um ISBN digitado errado não deve selecionar outra edição.
export function normalizedIsbn(value: string): string {
  const isbn = value.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{13}$/.test(isbn) && [...isbn].reduce((sum, n, i) => sum + Number(n) * (i % 2 ? 3 : 1), 0) % 10 === 0) return isbn;
  if (/^\d{9}[\dX]$/.test(isbn) && [...isbn].reduce((sum, n, i) => sum + (n === 'X' ? 10 : Number(n)) * (10 - i), 0) % 11 === 0) return isbn;
  throw new BadRequestException('ISBN inválido. Confira os 10 ou 13 caracteres.');
}
function isbn13(isbn: string) {
  if (isbn.length === 13) return isbn;
  const base = '978' + isbn.slice(0, 9);
  const check = (10 - [...base].reduce((sum, n, i) => sum + Number(n) * (i % 2 ? 3 : 1), 0) % 10) % 10;
  return base + check;
}

@Injectable()
export class BooksService {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private cache = new Map<string, { expires: number; value: unknown }>();
  private pending = new Map<string, Promise<unknown>>();
  private users = new Map<string, { count: number; expires: number }>();
  private blockedUntil = 0;
  limit(user: string) {
    const now = Date.now();
    for (const [id, entry] of this.users) if (entry.expires <= now) this.users.delete(id);
    const entry = this.users.get(user) || { count: 0, expires: now + 60000 };
    if (++entry.count > 30) throw new HttpException('Muitas buscas. Aguarde um minuto.', 429);
    this.users.set(user, entry);
  }
  private async cached<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.cache.get(key);
    if (previous && previous.expires > Date.now()) return previous.value as T;
    const pending = this.pending.get(key); if (pending) return pending as Promise<T>;
    const promise = work().then(value => {
      // Cache curto e limitado: evita repetir buscas sem montar uma cópia do catálogo externo.
      if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { value, expires: Date.now() + 15 * 60000 }); return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise); return promise;
  }
  private async request(path: string, params: Record<string, string> = {}, timeoutMs = 12000): Promise<any> {
    const key = process.env.GOOGLE_BOOKS_API_KEY?.trim();
    if (!key) throw new ServiceUnavailableException('A busca de livros ainda não está configurada. Você pode cadastrar manualmente.');
    if (this.blockedUntil > Date.now()) throw new ServiceUnavailableException('O Google Books atingiu o limite de consultas. Tente mais tarde ou cadastre manualmente.');
    const url = new URL('https://www.googleapis.com/books/v1/' + path);
    for (const [name, value] of Object.entries({ ...params, key })) url.searchParams.set(name, value);
    let response: Response;
    try { response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); }
    catch { throw new BadGatewayException('O Google Books não respondeu. Tente novamente ou cadastre manualmente.'); }
    if (response.status === 429) {
      this.blockedUntil = Date.now() + 60000;
      throw new ServiceUnavailableException('O Google Books atingiu o limite de consultas. Tente mais tarde ou cadastre manualmente.');
    }
    if (response.status === 404) throw new NotFoundException('Livro não encontrado no Google Books.');
    if (!response.ok) throw new BadGatewayException('Não foi possível consultar o Google Books. Tente novamente ou cadastre manualmente.');
    try {
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
      return data;
    } catch { throw new BadGatewayException('Resposta inválida do Google Books.'); }
  }
  private title(volume: Volume): BookTitleDto {
    if (!volume.id || !volumeId.test(volume.id) || !clean(volume.volumeInfo?.title)) throw new BadGatewayException('Resposta inválida do Google Books.');
    const info = volume.volumeInfo!;
    let coverUrl = '';
    try {
      const cover = new URL(info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '');
      // Apenas imagens do provedor; nenhum URL recebido do formulário vira um fetch do servidor.
      if (['books.google.com', 'books.googleusercontent.com'].includes(cover.hostname) && ['http:', 'https:'].includes(cover.protocol)) { cover.protocol = 'https:'; coverUrl = cover.toString(); }
    } catch { /* Uma edição sem capa continua disponível para cadastro. */ }
    const identifiers = Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers.filter(i => i && typeof i === 'object') : [];
    const isbn = identifiers.find(i => i.type === 'ISBN_13') || identifiers.find(i => i.type === 'ISBN_10');
    return { catalogId: `googlebooks:book:${volume.id}`, kind: 'book', title: clean(info.title),
      authors: Array.isArray(info.authors) ? info.authors.filter(a => typeof a === 'string').slice(0, 20).map(a => clean(a)) : [],
      genres: Array.isArray(info.categories) ? [...new Set(info.categories.filter(g => typeof g === 'string').map(g => clean(g, 150)).filter(Boolean))].slice(0, 20) : [],
      isbn: clean(isbn?.identifier, 13), publisher: clean(info.publisher), language: clean(info.language, 20),
      year: /^\d{4}/.exec(info.publishedDate || '')?.[0] || '', coverUrl,
      overview: clean(info.description, 4000), sourceUrl: `https://books.google.com/books?id=${encodeURIComponent(volume.id)}` };
  }
  async search(dto: BookSearchDto): Promise<BookSearchResultDto> {
    const term = dto.field === 'isbn' ? normalizedIsbn(dto.q) : dto.q;
    return this.cached(`search:${dto.field}:${term}:${dto.page}`, async () => {
      // Mantemos relevância do provedor e edições separadas por volume. Sem filtro de idioma
      // obrigatório: traduções/edições brasileiras nem sempre vêm etiquetadas corretamente.
      const prefix = { title: 'intitle:', author: 'inauthor:', isbn: 'isbn:' }[dto.field];
      const data = await this.request('volumes', { q: prefix + term.replace(/["\\]/g, ' '), printType: 'books', maxResults: '20', startIndex: String((dto.page - 1) * 20), orderBy: 'relevance' });
      if (data.kind !== 'books#volumes' || (data.items !== undefined && !Array.isArray(data.items))) throw new BadGatewayException('Resposta inválida do Google Books.');
      const volumes: Volume[] = data.items || [];
      const results = volumes.filter(v => v?.id && volumeId.test(v.id) && clean(v.volumeInfo?.title)).filter(v => {
        if (dto.field !== 'isbn') return true;
        const identifiers = v.volumeInfo?.industryIdentifiers;
        return Array.isArray(identifiers) && identifiers.some(i => {
          if (!i || typeof i.identifier !== 'string') return false;
          try { return isbn13(normalizedIsbn(i.identifier || '')) === isbn13(term); } catch { return false; }
        });
      }).map(v => this.title(v));
      return { results: [...new Map(results.map(v => [v.catalogId, v])).values()], nextPage: dto.field !== 'isbn' && volumes.length === 20 && dto.page < 50 && data.totalItems > dto.page * 20 ? dto.page + 1 : null };
    });
  }
  async detail(catalogId: string, timeoutMs = 12000): Promise<BookTitleDto> {
    const id = catalogId.startsWith('googlebooks:book:') ? catalogId.slice(17) : '';
    if (!volumeId.test(id)) throw new BadRequestException('Referência de livro inválida.');
    return this.cached('detail:' + id, async () => {
      const value = this.title(await this.request('volumes/' + encodeURIComponent(id), {}, timeoutMs));
      if (value.catalogId !== catalogId) throw new BadGatewayException('O Google Books retornou outra edição.');
      return value;
    });
  }
  private async generalSuggestions(page: number): Promise<BookSearchResultDto> {
    return this.cached('suggestions:pt:' + page, async () => {
      // Seleção geral do catálogo em português, compartilhada no cache. Não é
      // recomendação personalizada nem uma consulta por usuário à sua coleção.
      const data = await this.request('volumes', { q: 'literatura brasileira', langRestrict: 'pt', printType: 'books', maxResults: '20', startIndex: String((page - 1) * 20), orderBy: 'relevance' });
      if (data.kind !== 'books#volumes' || (data.items !== undefined && !Array.isArray(data.items))) throw new BadGatewayException('Resposta inválida do Google Books.');
      const volumes: Volume[] = data.items || [];
      const results = volumes.filter(v => v?.id && volumeId.test(v.id) && clean(v.volumeInfo?.title) && /^pt(?:-|$)/i.test(v.volumeInfo?.language || '')).map(v => this.title(v));
      return { results: [...new Map(results.map(v => [v.catalogId, v])).values()], nextPage: volumes.length === 20 && page < 50 && data.totalItems > page * 20 ? page + 1 : null };
    });
  }
  async suggestions(page = 1, ownerId?: string, context: 'collection' | 'reading' = 'collection'): Promise<BookSearchResultDto> {
    if (!ownerId) return { ...await this.generalSuggestions(page), personalized: false };
    const scope = { ownerId: new Types.ObjectId(ownerId), kind: 'book' };
    // Intenção de leitura não comprova posse. Cada tela consulta apenas seus próprios registros.
    const collection = this.connection.collection<OwnedBook>(context === 'reading' ? 'library_items' : 'collector_copies');
    const owned = await collection.find(scope, { projection: { title: 1, catalogId: 1, authors: 1, isbn: 1, genres: 1, publisher: 1, language: 1, bookMetadataVersion: 1 } }).sort({ updatedAt: -1, _id: -1 }).toArray();
    // Recupera gradualmente metadados de livros antigos. A atualização é restrita ao
    // dono/volume e não muda notas, edição, datas ou qualquer histórico de consumo.
    const missing = [...new Map(owned.filter(book => book.catalogId?.startsWith('googlebooks:book:') && book.bookMetadataVersion !== 1).map(book => [book.catalogId!, book])).values()].slice(0, 2);
    await Promise.allSettled(missing.map(async book => {
      const metadata = await this.detail(book.catalogId!, 6000);
      await collection.updateMany({ ...scope, catalogId: book.catalogId, bookMetadataVersion: { $ne: 1 } }, { $set: { genres: metadata.genres || [], publisher: metadata.publisher || book.publisher || '', bookMetadataVersion: 1 } });
      for (const copy of owned.filter(copy => copy.catalogId === book.catalogId)) { copy.genres = metadata.genres || []; copy.publisher = metadata.publisher || copy.publisher || ''; }
    }));
    const profile = bookPreferences(owned);
    const queryValue = (value: string) => value.replace(/["\\:]/g, ' ').trim().slice(0, 150);
    // Buscamos primeiro candidatos pelo título e autor. A editora só serve como
    // alternativa quando não há obras relacionadas ao título/autoria nos resultados.
    const queries = [
      profile.titles[0] && `intitle:"${queryValue(profile.titles[0].value)}"`,
      profile.authors[0] && `inauthor:"${queryValue(profile.authors[0].value)}"`,
      profile.publishers[0] ? `inpublisher:"${queryValue(profile.publishers[0].value)}"` : profile.genres[0] && `subject:"${queryValue(profile.genres[0].value)}"`,
    ].filter((q): q is string => Boolean(q));
    if (queries.length) {
      // O cache contém apenas candidatos públicos por consulta. Filtro de posse e
      // ordenação são recalculados por usuário, sem compartilhar seu perfil privado.
      const pages = await Promise.allSettled(queries.map(q => this.cached(`related:v2:${profile.language}:${q}:${page}`, async () => {
        const data = await this.request('volumes', { q, langRestrict: profile.language, printType: 'books', maxResults: '20', startIndex: String((page - 1) * 20), orderBy: 'relevance' }, 8000);
        if (data.kind !== 'books#volumes' || (data.items !== undefined && !Array.isArray(data.items))) throw new BadGatewayException('Resposta inválida do Google Books.');
        const volumes: Volume[] = data.items || [];
        // O idioma desempata a ordenação, sem descartar o mesmo autor/série em outra língua.
        return { results: volumes.filter(v => v?.id && volumeId.test(v.id) && clean(v.volumeInfo?.title)).map(v => this.title(v)), nextPage: volumes.length === 20 && page < 50 && data.totalItems > page * 20 ? page + 1 : null };
      })));
      const successful = pages.filter((p): p is PromiseFulfilledResult<BookSearchResultDto> => p.status === 'fulfilled');
      if (!successful.length) throw (pages[0] as PromiseRejectedResult).reason;
      const candidates = [...new Map(successful.flatMap(p => p.value.results).map(book => [book.catalogId, book])).values()];
      const eligible = candidates.filter(book => !alreadyOwned(book, owned) && bookAffinity(book, profile) > 0);
      const related = eligible.filter(book => bookAffinity(book, profile) >= 2000000);
      // Não completamos a grade com títulos aleatórios da editora quando já há
      // correspondências por título/autor; isso evita que uma editora grande domine a lista.
      const results = (related.length ? related : eligible).sort((a, b) => bookAffinity(b, profile) - bookAffinity(a, profile)).slice(0, 20);
      if (results.length) return { results, nextPage: successful.some(p => p.value.nextPage) ? page + 1 : null, personalized: true };
    }
    const general = await this.generalSuggestions(page);
    return { ...general, results: general.results.filter(book => !alreadyOwned(book, owned)), personalized: false };
  }
}

@ApiTags('books') @ApiCookieAuth('session')
@Controller('catalog/books')
export class BooksController {
  constructor(private readonly books: BooksService, private readonly auth: AuthService) {}
  private async authorize(request: Request) {
    const token: unknown = request.cookies?.[getConfig().cookieName];
    const user = await this.auth.me(typeof token === 'string' ? token : undefined);
    this.books.limit(user.id);
    return user;
  }
  @Get('suggestions')
  @ApiOperation({ summary: 'Sugestões baseadas nos livros privados', description: 'context=collection (padrão) considera exemplares possuídos; context=reading considera apenas o acompanhamento de leitura. Os contextos são independentes e restritos à sessão. Prioridade estrita: afinidade textual de título, depois mesmo autor e depois editora; gênero desempata. Afinidade de título é heurística, sem identificação oficial de franquia. Havendo resultados por título/autor, não completa a lista com editora apenas. Prefere o idioma do acervo sem excluir traduções relacionadas. Cópias repetidas não aumentam preferência; exclui posse e isola por sessão. Recupera metadados de até dois volumes antigos sem alterar datas/acompanhamento. Sem correspondências, seleção geral com personalized=false. Cache só de candidatos públicos; até 20 resultados por página.' })
  @ApiOkResponse({ type: BookSearchResultDto })
  @ApiResponse({ status: 400, description: 'Página inválida ou parâmetro desconhecido.' })
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @ApiResponse({ status: 429, description: 'Limite de consultas por usuário.' })
  @ApiResponse({ status: 502, description: 'Falha na consulta ao Google Books.' })
  @ApiResponse({ status: 503, description: 'Chave ausente ou cota esgotada; cadastro manual disponível.' })
  async suggestions(@Req() request: Request, @Query() dto: BookSuggestionsDto) {
    const user = await this.authorize(request); return this.books.suggestions(dto.page, user.id, dto.context);
  }
  @Get('search')
  @ApiOperation({ summary: 'Buscar livros no Google Books por título, autor ou ISBN', description: 'Usada pela busca automática após pausa na digitação e pelo envio manual. 20 volumes por página. ISBN exige dígito verificador válido e correspondência exata da edição. Não altera acervo nem acompanhamento.' })
  @ApiOkResponse({ type: BookSearchResultDto })
  @ApiResponse({ status: 400, description: 'Termo, tipo de busca, página ou ISBN inválido.' })
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @ApiResponse({ status: 429, description: 'Limite de buscas por usuário.' })
  @ApiResponse({ status: 502, description: 'Provedor indisponível ou resposta inválida.' })
  @ApiResponse({ status: 503, description: 'Chave não configurada ou cota do Google Books esgotada. Cadastro manual continua disponível.' })
  async search(@Req() request: Request, @Query() dto: BookSearchDto) {
    await this.authorize(request); return this.books.search(dto);
  }
}
@Module({ imports: [AuthModule], providers: [BooksService], controllers: [BooksController], exports: [BooksService] })
export class BooksModule {}
