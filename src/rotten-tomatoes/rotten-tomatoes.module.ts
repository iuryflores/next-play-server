import { ApiTags, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { BadGatewayException, BadRequestException, Controller, Get, Injectable, Module, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { CatalogModule, CatalogService } from '../catalog/catalog.module';
import { getConfig } from '../config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

type Hit = { type?: unknown; title?: unknown; vanity?: unknown; releaseYear?: unknown; castCrew?: { crew?: { Director?: unknown } }; rottenTomatoes?: { criticsScore?: unknown; audienceScore?: unknown } };
export function score(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
export function movieResult(hit: Hit, kind: 'movie' | 'series' = 'movie') {
  if (hit?.type !== (kind === 'series' ? 'tv' : 'movie') || typeof hit.title !== 'string' || !hit.title.trim() || typeof hit.vanity !== 'string' || !/^[a-z0-9_\-]{1,200}$/.test(hit.vanity)) return null;
  return {
    title: hit.title.slice(0, 200),
    directors: Array.isArray(hit.castCrew?.crew?.Director) ? hit.castCrew.crew.Director.filter((value): value is string => typeof value === 'string').slice(0, 5).map(name => name.slice(0, 200)) : [],
    year: typeof hit.releaseYear === 'number' && Number.isInteger(hit.releaseYear) ? hit.releaseYear : null,
    url: `https://www.rottentomatoes.com/${kind === 'series' ? 'tv' : 'm'}/${hit.vanity}`,
    tomatometer: score(hit.rottenTomatoes?.criticsScore),
    popcornmeter: score(hit.rottenTomatoes?.audienceScore),
  };
}

@Injectable()
export class RottenTomatoesService {
  private cache = new Map<string, { expires: number; data: { results: NonNullable<ReturnType<typeof movieResult>>[]; queriedAt: string } }>();
  async search(query: unknown, kind: string = 'movie', year?: string) {
    if (year !== undefined && (typeof year !== 'string' || !/^\d{4}$/.test(year))) throw new BadRequestException('Ano inválido.');
    if (kind !== 'movie' && kind !== 'series') throw new BadRequestException('Escolha filmes ou séries.');
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100) throw new BadRequestException('Digite entre 2 e 100 caracteres para buscar.');
    const appId = process.env.ROTTEN_TOMATOES_ALGOLIA_APP_ID || '';
    const apiKey = process.env.ROTTEN_TOMATOES_ALGOLIA_API_KEY || '';
    const index = process.env.ROTTEN_TOMATOES_ALGOLIA_INDEX || 'content_rt';
    if (process.env.ROTTEN_TOMATOES_ENABLED !== 'true' || !/^[A-Z0-9]{10}$/.test(appId) || !apiKey || !/^[a-zA-Z0-9_\-]{1,100}$/.test(index)) throw new ServiceUnavailableException('A consulta ao Rotten Tomatoes ainda não está configurada.');
    const key = kind + ':' + (year || 'all') + ':' + query.trim().toLowerCase();
    for (const [key, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(key);
    const cached = this.cache.get(key);
    if (cached) return cached.data;
    try {
      const response = await fetch(`https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { 'Content-Type': 'application/json', 'X-Algolia-Application-Id': appId, 'X-Algolia-API-Key': apiKey },
        body: JSON.stringify({ requests: [{ indexName: index, query: query.trim(), params: new URLSearchParams({ filters: `isEmsSearchable = 1 AND type:${kind === 'series' ? 'tv' : 'movie'}${year ? ` AND releaseYear = ${Number(year)}` : ''}`, hitsPerPage: '8', attributesToRetrieve: 'title,releaseYear,type,vanity,rottenTomatoes,castCrew.crew.Director', attributesToHighlight: '', removeWordsIfNoResults: 'none', optionalWords: '[]', restrictSearchableAttributes: 'title,aka', analytics: 'false', clickAnalytics: 'false' }).toString() }] }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Provider unavailable'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty response');
      const decoder = new TextDecoder();
      let text = ''; let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 262144) { await reader.cancel(); throw new Error('Response too large'); }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
      const payload = JSON.parse(text) as { results?: { hits?: Hit[] }[] };
      if (!Array.isArray(payload.results?.[0]?.hits)) throw new Error('Invalid response');
      const results = [...new Map(payload.results[0].hits.slice(0, 8).map(hit => movieResult(hit, kind)).filter((item): item is NonNullable<typeof item> => item !== null && (!year || item.year === Number(year))).map(item => [item.url, item])).values()];
      const data = { results, queriedAt: new Date().toISOString() };
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expires: Date.now() + 600000, data });
      return data;
    } catch { throw new BadGatewayException('Não foi possível consultar o Rotten Tomatoes. Tente novamente mais tarde.'); }
  }
}

@ApiTags('rotten-tomatoes')
@ApiCookieAuth('session')
@Controller('rotten-tomatoes')
export class RottenTomatoesController {
  constructor(private readonly service: RottenTomatoesService, private readonly auth: AuthService, private readonly catalog: CatalogService, @InjectConnection() private readonly db:Connection) {}
  @Get('search') @ApiOperation({summary:'Buscar notas públicas do Rotten Tomatoes',description:'Com catalogId TMDB válido, resolve título original/diretores e mantém snapshot público para estatísticas somente quando título/ano/direção identificam um resultado inequívoco. Busca textual comum não grava correspondência. Não salva notas privadas; ausência não vira zero.'}) async search(@Req() request: Request, @Query('q') query: string, @Query('catalogId') catalogId?: string, @Query('kind') kind = 'movie', @Query('year') year?: string) {
    const raw: unknown = request.cookies?.[getConfig().cookieName];
    const user = await this.auth.me(typeof raw === 'string' ? raw : undefined);
    this.catalog.limit(user.id);
    if (kind !== 'movie' && kind !== 'series') throw new BadRequestException('Escolha filmes ou séries.');
    if (catalogId !== undefined) {
      if (typeof catalogId !== 'string' || (!/^tmdb:(movie|series):[1-9]\d{0,14}$/.test(catalogId) || catalogId.split(':')[1] !== kind)) throw new BadRequestException('Referência de título inválida.');
      const movie = await this.catalog.detail(catalogId, 'en-US');
      const title = (movie.originalTitle || movie.title).slice(0, 100);
      const searchedDirectors = kind === 'movie' ? (await this.catalog.directors(catalogId)).directors.map(director => director.name) : undefined;
      const result=await this.service.search(title, kind, year);
      const normalize=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
      const matches=result.results.filter(row=>row.year===Number(year||movie.year)&&normalize(row.title)===normalize(title)&&(!searchedDirectors||searchedDirectors.length>0&&searchedDirectors.every(name=>row.directors.some(other=>normalize(other)===normalize(name)))));
      // Só guarda correspondência inequívoca do catálogo, sem converter o Tomatometer em nota de qualidade.
      if(matches.length===1)await this.db.collection('catalog_critic_scores').updateOne({_id:catalogId as any},{$set:{value:matches[0],queriedAt:new Date(result.queriedAt)}},{upsert:true});
      return { ...result, searchedTitle: title, ...(searchedDirectors ? { searchedDirectors } : {}) };
    }
    return this.service.search(query, kind, year);
  }
}
@Module({ imports: [AuthModule, CatalogModule], controllers: [RottenTomatoesController], providers: [RottenTomatoesService] })
export class RottenTomatoesModule {}
