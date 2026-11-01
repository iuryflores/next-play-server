import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { BadGatewayException, BadRequestException, Controller, Get, HttpException, Injectable, Module, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config';

export type CatalogKind = 'movie' | 'series' | 'game';
export type ProductionCompany = { id: number; name: string; logoUrl?: string | null };
export interface CatalogTitle { platforms?: string[]; productionCompanies?: ProductionCompany[]; catalogId: string; kind: CatalogKind; title: string; originalTitle?: string; year: string; runtime?: number | null; releaseDate?: string; unreleased?: boolean; coverUrl: string; overview: string; sourceUrl: string; genres?: string[]; }
type TmdbItem = { production_companies?: { id: number; name: string; logo_path?: string | null }[]; runtime?: number; status?: string; id: number; title?: string; name?: string; original_title?: string; original_name?: string; poster_path?: string; overview?: string; release_date?: string; first_air_date?: string; adult?: boolean; genres?: { id: number; name: string }[] };
type IgdbItem = { platforms?: { name: string; abbreviation?: string }[]; game_localizations?: { name?: string; region?: { identifier?: string } }[]; id: number; name: string; summary?: string; first_release_date?: number; cover?: { image_id: string }; slug?: string; genres?: { id: number; name: string }[] };
@Injectable()
export class CatalogService {
  async directors(catalogId: string | undefined) {
    type Director = { id: number; name: string };
    if (!catalogId || !/^tmdb:movie:[1-9]\d{0,14}$/.test(catalogId)) return { directors: [] as Director[], supported: false };
    const collection = this.connection.collection<{ _id: string; directors: Director[]; expires: Date }>('catalog_directors');
    const cached = await collection.findOne({ _id: catalogId });
    if (cached && cached.expires > new Date()) return { directors: cached.directors, supported: true };
    const data = await this.tmdb<{ crew?: { id: number; name: string; job: string }[] }>('movie/' + catalogId.split(':')[2] + '/credits');
    if (!Array.isArray(data.crew)) throw new BadGatewayException('Não foi possível carregar a direção do filme.');
    const directors = [...new Map(data.crew.filter(person => person.job === 'Director' && Number.isSafeInteger(person.id) && person.id > 0 && typeof person.name === 'string' && person.name.trim()).map(person => [person.id, { id: person.id, name: person.name.trim().slice(0, 200) }])).values()];
    await collection.updateOne({ _id: catalogId }, { $set: { directors, expires: new Date(Date.now() + 7 * 86400000) } }, { upsert: true });
    return { directors, supported: true };
  }

  async trailer(catalogId: string | undefined, language: string) {
    type Video = { key: string; name: string; site: string; type: string; official?: boolean };
    type Trailer = { key: string; name: string; language: string };
    if (!catalogId || !/^tmdb:(movie|series):[1-9]\d{0,14}$/.test(catalogId)) return null;
    const collection = this.connection.collection<{ _id: string; value: Trailer | null; expires: Date }>('catalog_trailers');
    const key = `${catalogId}:${language}`;
    const cached = await collection.findOne({ _id: key });
    if (cached && cached.expires > new Date()) return cached.value;
    const [, kind, id] = catalogId.split(':');
    let value: Trailer | null = null;
    for (const locale of [...new Set([language, 'en-US'])]) {
      const data = await this.tmdb<{ results: Video[] }>(`${kind === 'movie' ? 'movie' : 'tv'}/${id}/videos`, { language: locale });
      if (!Array.isArray(data.results)) throw new BadGatewayException('Resposta inválida do catálogo.');
      const video = data.results.filter(video => video.site === 'YouTube' && /^[A-Za-z0-9_-]{11}$/.test(video.key) && ['Trailer', 'Teaser'].includes(video.type)).sort((a, b) => Number(b.type === 'Trailer') - Number(a.type === 'Trailer') || Number(Boolean(b.official)) - Number(Boolean(a.official)))[0];
      if (video) { value = { key: video.key, name: String(video.name || 'Trailer').slice(0, 200), language: locale }; break; }
    }
    await collection.updateOne({ _id: key }, { $set: { value, expires: new Date(Date.now() + 86400000) } }, { upsert: true });
    return value;
  }
  async cast(catalogId: string | undefined, language: string, season?: number, episode?: number) {
    if ((season !== undefined || episode !== undefined) && (!Number.isInteger(season) || season! < 0 || season! > 10000 || !Number.isInteger(episode) || episode! < 1 || episode! > 100000)) throw new BadRequestException('Episódio inválido.');
    if (!catalogId || !/^tmdb:(movie|series):[1-9]\d{0,14}$/.test(catalogId)) return [];
    const [, kind, id] = catalogId.split(':');
    if (kind === 'movie' && season !== undefined) throw new BadRequestException('Episódio inválido.');
    type Character = { id: string; actor: string; character: string; photo: string };
    const collection = this.connection.collection<{ _id: string; cast: Character[]; expires: Date }>('catalog_cast');
    const key = `${catalogId}:${language}:${season ?? 'all'}:${episode ?? 'all'}`;
    const cached = await collection.findOne({ _id: key });
    if (cached && cached.expires > new Date()) return cached.cast;
    type Person = { id: number; name: string; character?: string; profile_path?: string; roles?: { character: string }[] };
    const path = kind === 'movie' ? `movie/${id}/credits` : season === undefined ? `tv/${id}/aggregate_credits` : `tv/${id}/season/${season}/episode/${episode}/credits`;
    let data: { cast?: Person[]; guest_stars?: Person[] };
    try { data = await this.tmdb(path, { language }); } catch (error) { if (cached) return cached.cast; throw error; }
    if (!Array.isArray(data.cast)) throw new BadGatewayException('Resposta inválida do catálogo.');
    const roles = [...data.cast, ...(data.guest_stars || [])].filter(person => Number.isSafeInteger(person.id) && typeof person.name === 'string').flatMap(person => (person.roles || [{ character: person.character || '' }]).filter(role => typeof role.character === 'string' && role.character.trim()).map(role => ({ id: `${person.id}:${role.character}`, actor: person.name.slice(0, 200), character: role.character.trim().slice(0, 100), photo: /^\/[A-Za-z0-9_.-]+$/.test(person.profile_path || '') ? `https://image.tmdb.org/t/p/w185${person.profile_path}` : '' })));
    const cast = [...new Map(roles.map(role => [role.id, role])).values()];
    await collection.updateOne({ _id: key }, { $set: { cast, expires: new Date(Date.now() + 7 * 86400000) } }, { upsert: true });
    return cast;
  }
  private localizedPending = new Map<string, Promise<{ title?: string; overview?: string }>>();
  async localizedEpisodes(catalogId: string, season: number, language: string) {
    type LocalEpisode = { number: number; name: string; overview: string };
    const collection = this.connection.collection<{ _id: string; episodes: LocalEpisode[]; expires?: Date }>('episode_translations');
    const key = `${catalogId}:${season}:${language}`;
    const saved = await collection.findOne({ _id: key });
    if (saved && saved.expires && saved.expires > new Date()) return saved.episodes;
    try {
      const episodes = await this.seasonEpisodes(catalogId, season, language);
      await collection.updateOne({ _id: key }, { $set: { episodes, expires: new Date(Date.now() + 86400000) } }, { upsert: true });
      return episodes;
    } catch { return saved?.episodes || []; }
  }
  private async translation(catalogId: string, language: string, fetchMissing: boolean) {
    const collection = this.connection.collection<{ _id: string; value: { title?: string; overview?: string }; expires: Date }>('catalog_translations');
    const key = `${catalogId}:${language}`;
    const saved = await collection.findOne({ _id: key });
    if (saved && (saved.expires > new Date() || !fetchMissing)) return saved.value;
    if (!fetchMissing) return {};
    const pending = this.localizedPending.get(key); if (pending) return pending;
    const work = (async () => {
      try {
        const translated = await this.detail(catalogId, language);
        const value = { title: translated.title, overview: translated.overview };
        await collection.updateOne({ _id: key }, { $set: { value, expires: new Date(Date.now() + 30 * 86400000) } }, { upsert: true });
        return value;
      } catch { return saved?.value || {}; }
    })().finally(() => this.localizedPending.delete(key));
    this.localizedPending.set(key, work); return work;
  }
  async localize<T extends { catalogId?: string; title?: string; overview?: string }>(item: T, language: string, fetchMissing = true): Promise<T> {
    if (!item.catalogId || !/^(tmdb|igdb):/.test(item.catalogId) || !['en-US', 'es-ES'].includes(language)) return item;
    const value = await this.translation(item.catalogId, language, fetchMissing);
    const result = { ...item, title: value.title || item.title, overview: value.overview || item.overview };
    const progress = (result as T & { episodeProgress?: { next?: { season: number; episode: number | null; name?: string } | null } }).episodeProgress;
    if (fetchMissing && item.catalogId.startsWith('tmdb:series:') && progress?.next?.episode) {
      const episodes = await this.localizedEpisodes(item.catalogId, progress.next.season, language);
      progress.next.name = episodes.find(episode => episode.number === progress.next!.episode)?.name || progress.next.name;
    }
    return result;
  }
  async localizeMany<T extends { catalogId?: string; title?: string; overview?: string }>(items: T[], language: string) {
    if (!['en-US', 'es-ES'].includes(language) || !items.length) return items;
    // Collection reads must not wait for hundreds of remote refreshes. Stale saved
    // translations are useful here; detail views can refresh individual titles.
    const keys = [...new Set(items.filter(item => item.catalogId && /^(tmdb|igdb):/.test(item.catalogId)).map(item => `${item.catalogId}:${language}`))];
    if (!keys.length) return items;
    type Progress = { next?: { season: number; episode: number | null; name?: string } | null };
    const episodeKeys = [...new Set(items.flatMap(item => {
      const next = (item as T & { episodeProgress?: Progress }).episodeProgress?.next;
      return item.catalogId?.startsWith('tmdb:series:') && next?.episode ? [`${item.catalogId}:${next.season}:${language}`] : [];
    }))];
    const [titles, episodes] = await Promise.all([
      this.connection.collection<{ _id: string; value: { title?: string; overview?: string } }>('catalog_translations').find({ _id: { $in: keys } }).toArray(),
      episodeKeys.length ? this.connection.collection<{ _id: string; episodes: { number: number; name: string }[] }>('episode_translations').find({ _id: { $in: episodeKeys } }).toArray() : [],
    ]);
    const translated = new Map(titles.map(row => [row._id, row.value]));
    const localizedEpisodes = new Map(episodes.map(row => [row._id, row.episodes]));
    return items.map(item => {
      const value = translated.get(`${item.catalogId}:${language}`);
      const result = { ...item, title: value?.title || item.title, overview: value?.overview || item.overview };
      const progress = (item as T & { episodeProgress?: Progress }).episodeProgress;
      if (progress?.next?.episode) {
        const next = progress.next;
        const name = localizedEpisodes.get(`${item.catalogId}:${next.season}:${language}`)?.find(episode => episode.number === next.episode)?.name;
        if (name) (result as T & { episodeProgress?: Progress }).episodeProgress = { ...progress, next: { ...next, name } };
      }
      return result;
    });
  }
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private genreCache = new Map<string, { expires: number; values: { id: number; name: string }[] }>();
  private cache = new Map<string, { expires: number; value: CatalogTitle[] }>();
  private accessToken = ''; private tokenExpires = 0; private tokenPromise?: Promise<string>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequest = 0;
  private users = new Map<string, { count: number; until: number }>();
  available() { return { tmdb: Boolean(process.env.TMDB_API_ACCESS_TOKEN || process.env.TMDB_API_KEY), igdb: Boolean(process.env.IGDB_CLIENT_ID && process.env.IGDB_CLIENT_SECRET) }; }
  limit(user: string) {
    const now = Date.now();
    for (const [key, value] of this.users) if (value.until <= now) this.users.delete(key);
    const value = this.users.get(user) || { count: 0, until: now + 60000 }; value.count++; this.users.set(user, value);
    if (value.count > 30) throw new HttpException('Muitas buscas. Aguarde um minuto e tente novamente.', 429);
  }
  private async json<T>(url: string, options?: RequestInit): Promise<T> {
    let response: Response;
    try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) }); }
    catch { throw new BadGatewayException('O catálogo não respondeu. Tente novamente em instantes.'); }
    if (!response.ok) {
      if (response.status === 429) throw new ServiceUnavailableException('O catálogo atingiu o limite de consultas. Tente novamente em instantes.');
      if (response.status === 401 || response.status === 403) { if (url.startsWith('https://api.igdb.com/')) { this.accessToken = ''; this.tokenExpires = 0; } throw new ServiceUnavailableException('O catálogo recusou as credenciais. Confira a configuração no servidor.'); }
      throw new BadGatewayException('Não foi possível consultar esse título no catálogo.');
    }
    try { return await response.json() as T; } catch { throw new BadGatewayException('O catálogo retornou uma resposta inválida.'); }
  }
  private async tmdb<T>(path: string, query: Record<string, string> = {}) {
    if (!this.available().tmdb) throw new ServiceUnavailableException('O catálogo de filmes e séries ainda não está configurado.');
    const url = new URL(`https://api.themoviedb.org/3/${path}`);
    url.searchParams.set('language', 'pt-BR');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const token = process.env.TMDB_API_ACCESS_TOKEN;
    if (!token) url.searchParams.set('api_key', process.env.TMDB_API_KEY!);
    return this.json<T>(url.toString(), { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  }
  private token(): Promise<string> {
    if (!this.available().igdb) throw new ServiceUnavailableException('O catálogo de jogos precisa de IGDB_CLIENT_ID e IGDB_CLIENT_SECRET no servidor.');
    if (this.accessToken && this.tokenExpires > Date.now()) return Promise.resolve(this.accessToken);
    if (!this.tokenPromise) this.tokenPromise = this.json<{ access_token: string; expires_in: number }>('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.IGDB_CLIENT_ID!, client_secret: process.env.IGDB_CLIENT_SECRET!, grant_type: 'client_credentials' }).toString() }).then(data => {
      if (!data.access_token || !Number.isFinite(data.expires_in)) throw new BadGatewayException('A autenticação do catálogo de jogos falhou.');
      this.accessToken = data.access_token; this.tokenExpires = Date.now() + Math.max(0, data.expires_in - 60) * 1000; return this.accessToken;
    }).finally(() => { this.tokenPromise = undefined; });
    return this.tokenPromise;
  }
  private igdb<T = IgdbItem[]>(body: string, endpoint = 'games'): Promise<T> {
    const task = this.queue.then(async () => {
      const access = await this.token();
      const delay = Math.max(0, this.lastRequest + 300 - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      this.lastRequest = Date.now();
      return this.json<T>('https://api.igdb.com/v4/' + endpoint, { method: 'POST', headers: { 'Client-ID': process.env.IGDB_CLIENT_ID!, Authorization: `Bearer ${access}`, 'Content-Type': 'text/plain' }, body });
    });
    this.queue = task.catch(() => undefined); return task;
  }
  private movie(item: TmdbItem, kind: 'movie' | 'series'): CatalogTitle {
    const path = item.poster_path || '';
    return { productionCompanies: item.production_companies ? [...new Map(item.production_companies.filter(company => Number.isSafeInteger(company.id) && company.id > 0 && typeof company.name === 'string' && company.name.trim()).map(company => [company.id, { id: company.id, name: company.name.trim().slice(0, 200), logoUrl: /^\/[A-Za-z0-9_.-]+$/.test(company.logo_path || '') ? 'https://image.tmdb.org/t/p/w185' + company.logo_path : null }])).values()] : undefined, catalogId: `tmdb:${kind}:${item.id}`, kind, runtime: kind === 'movie' && typeof item.runtime === 'number' && item.runtime > 0 ? item.runtime : null, releaseDate: item.release_date || item.first_air_date || '', unreleased: ['Rumored', 'Planned', 'In Production', 'Post Production', 'Pilot'].includes(item.status || ''), originalTitle: (item.original_title || item.original_name || '').slice(0, 200), genres: (item.genres || []).map(g => g.name), title: (item.title || item.name || 'Sem título').slice(0, 200), year: (item.release_date || item.first_air_date || '').slice(0, 4), overview: (item.overview || '').slice(0, 4000), coverUrl: /^\/[A-Za-z0-9_.-]+$/.test(path) ? `https://image.tmdb.org/t/p/w342${path}` : '', sourceUrl: `https://www.themoviedb.org/${kind === 'movie' ? 'movie' : 'tv'}/${item.id}` };
  }
  private game(item: IgdbItem, language = 'pt-BR'): CatalogTitle {
    const image = item.cover?.image_id || '';
    const translated = item.game_localizations?.find(value => value.region?.identifier?.replace('_', '-').toLowerCase() === language.toLowerCase())?.name || item.name;
    const platformNames: Record<string, string> = { 'PC (Microsoft Windows)': 'PC', PlayStation: 'PS1', 'PlayStation 2': 'PS2', 'PlayStation 3': 'PS3', 'PlayStation 4': 'PS4', 'PlayStation 5': 'PS5' };
    const platforms = [...new Set((item.platforms || []).map(platform => platformNames[platform.name] || platform.name?.trim() || platform.abbreviation?.trim()).filter((name): name is string => Boolean(name)))];
    return { platforms, catalogId: `igdb:game:${item.id}`, kind: 'game', releaseDate: item.first_release_date ? new Date(item.first_release_date * 1000).toISOString().slice(0, 10) : '', originalTitle: item.name.slice(0, 200), genres: (item.genres || []).map(g => g.name), title: translated.slice(0, 200), year: item.first_release_date ? new Date(item.first_release_date * 1000).getUTCFullYear().toString() : '', overview: (item.summary || '').slice(0, 4000), coverUrl: /^[A-Za-z0-9_-]+$/.test(image) ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${image}.jpg` : '', sourceUrl: item.slug && /^[a-z0-9-]+$/.test(item.slug) ? `https://www.igdb.com/games/${item.slug}` : 'https://www.igdb.com' };
  }
  private cached(key: string) {
    for (const [id, data] of this.cache) if (data.expires < Date.now()) this.cache.delete(id);
    return this.cache.get(key)?.value;
  }
  private remember(key: string, value: CatalogTitle[]) {
    if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: Date.now() + 600000, value }); return value;
  }
  async suggestions(kind: string, ownerId?: string, language = 'pt-BR', page = 1, platform?: number) {
    if (platform !== undefined && (kind !== 'game' || !Number.isSafeInteger(platform) || platform < 1)) throw new BadRequestException('Plataforma inválida.');
    if (!Number.isInteger(page) || page < 1 || page > 500) throw new BadRequestException('Página inválida.');
    if (!['movie', 'series', 'game'].includes(kind)) throw new BadRequestException('Escolha filmes, séries ou jogos.');
    const owned = ownerId ? await this.connection.collection('library_items').find({ ownerId: new Types.ObjectId(ownerId), kind }, { projection: { genres: 1, catalogId: 1, title: 1 } }).sort({ createdAt: -1, _id: -1 }).toArray() : [];
    const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const weights = new Map<string, number>();
    owned.slice(0, 40).forEach((item, index) => {
      for (const genre of new Set<string>(item.genres || [])) {
        const name = normalize(genre);
        weights.set(name, (weights.get(name) || 0) + (index < 5 ? 3 : 1));
      }
    });
    let directory: { id: number; name: string }[] = [];
    if (weights.size) {
      const stored = this.genreCache.get(kind);
      if (stored && stored.expires > Date.now()) directory = stored.values;
      else {
        directory = kind === 'game'
          ? await this.igdb<{ id: number; name: string }[]>('fields name; limit 100;', 'genres')
          : (await this.tmdb<{ genres: { id: number; name: string }[] }>(`genre/${kind === 'movie' ? 'movie' : 'tv'}/list`)).genres;
        if (!Array.isArray(directory)) throw new BadGatewayException('Resposta inválida do catálogo de gêneros.');
        directory = directory.filter(g => Number.isSafeInteger(g.id) && typeof g.name === 'string');
        this.genreCache.set(kind, { expires: Date.now() + 86400000, values: directory });
      }
    }
    const preferred = directory.filter(g => weights.has(normalize(g.name))).sort((a, b) => weights.get(normalize(b.name))! - weights.get(normalize(a.name))!).slice(0, 3);
    const ids = preferred.map(g => g.id).sort((a, b) => a - b);
    const key = 'suggestions:' + kind + ':' + ids.join(',') + ':' + language + ':' + page + ':' + (platform ?? 'all');
    const cached = this.cached(key);
    let results: CatalogTitle[];
    if (cached) results = cached;
    else if (kind === 'game') {
      const data = await this.igdb(`fields name,summary,first_release_date,cover.image_id,slug,genres.name,platforms.name,platforms.abbreviation,game_localizations.name,game_localizations.region.identifier; where rating_count >= 20 & cover != null${platform ? ` & platforms = (${platform})` : ''}${ids.length ? ` & genres = (${ids.join(',')})` : ''}; sort rating desc; limit 20; offset ${(page - 1) * 20};`);
      if (!Array.isArray(data)) throw new BadGatewayException('Resposta inválida do catálogo.');
      results = data.filter(item => Number.isSafeInteger(item.id) && typeof item.name === 'string').map(item => this.game(item, language));
    } else {
      const type = kind === 'movie' ? 'movie' : 'tv';
      const pages = await Promise.all([page].map(page => this.tmdb<{ results: (TmdbItem & { genre_ids?: number[] })[] }>(ids.length ? `discover/${type}` : `${type}/popular`, { language, page: String(page), include_adult: 'false', ...(ids.length ? { with_genres: ids.join('|'), sort_by: 'popularity.desc' } : {}) })));
      if (pages.some(data => !Array.isArray(data.results))) throw new BadGatewayException('Resposta inválida do catálogo.');
      results = pages.flatMap(data => data.results).filter(item => Number.isSafeInteger(item.id) && !item.adult).map(item => this.movie({ ...item, genres: item.genres || directory.filter(g => item.genre_ids?.includes(g.id)) }, kind as 'movie' | 'series'));
    }
    if (!cached) this.remember(key, results);
    const ownedIds = new Set(owned.map(item => item.catalogId));
    const ownedNames = new Set(owned.map(item => normalize(item.title)));
    const unique = [...new Map(results.map(item => [item.catalogId, item])).values()];
    const score = (item: CatalogTitle) => (item.genres || []).reduce((sum, name) => sum + (weights.get(normalize(name)) || 0), 0);
    return { results: unique.filter(item => !ownedIds.has(item.catalogId) && !ownedNames.has(normalize(item.title))).sort((a, b) => score(b) - score(a)), nextPage: results.length >= 20 && page < 500 ? page + 1 : null };
  }
  private searchCache = new Map<string, { expires: number; value: { results: CatalogTitle[]; nextPage: number | null } }>();
  async search(kind: string, query: string, language = 'pt-BR', page = 1, platform?: number) {
    if (platform !== undefined && (kind !== 'game' || !Number.isSafeInteger(platform) || platform < 1)) throw new BadRequestException('Plataforma inválida.');
    if (!Number.isInteger(page) || page < 1 || page > 500) throw new BadRequestException('Página inválida.');
    if (!['movie', 'series', 'game'].includes(kind)) throw new BadRequestException('Escolha filmes, séries ou jogos. Livros continuam no cadastro manual.');
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100) throw new BadRequestException('Digite entre 2 e 100 caracteres para buscar.');
    const text = query.trim(); const key = `search:${kind}:${language}:${page}:${platform ?? 'all'}:${createHash('sha256').update(text.toLowerCase()).digest('hex')}`;
    for (const [id, entry] of this.searchCache) if (entry.expires < Date.now()) this.searchCache.delete(id);
    const cached = this.searchCache.get(key); if (cached) return cached.value;
    let nextPage: number | null = null;
    let results: CatalogTitle[];
    if (kind === 'game') {
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\x00-\x1f]/g, ' ');
      const data = await this.igdb(`search "${escaped}"; fields name,summary,first_release_date,cover.image_id,slug,genres.name,platforms.name,platforms.abbreviation,game_localizations.name,game_localizations.region.identifier; ${platform ? `where platforms = (${platform}); ` : ''}limit 21; offset ${(page - 1) * 20};`);
      if (!Array.isArray(data)) throw new BadGatewayException('Resposta inválida do catálogo.');
      nextPage = data.length > 20 && page < 500 ? page + 1 : null;
      results = data.slice(0, 20).filter(item => Number.isSafeInteger(item.id) && typeof item.name === 'string').map(item => this.game(item, language));
    } else {
      const data = await this.tmdb<{ results: TmdbItem[]; total_pages?: number }>(`search/${kind === 'movie' ? 'movie' : 'tv'}`, { language, query: text, include_adult: 'false', page: String(page) });
      if (!Array.isArray(data.results)) throw new BadGatewayException('Resposta inválida do catálogo.');
      results = data.results.filter(item => Number.isSafeInteger(item.id) && !item.adult).map(item => this.movie(item, kind as 'movie' | 'series'));
      nextPage = page < Math.min(data.total_pages || 0, 500) ? page + 1 : null;
      const companies = await this.tmdb<{ results: { id: number; name: string }[] }>('search/company', { query: text, page: '1' });
      if (!Array.isArray(companies.results)) throw new BadGatewayException('Resposta inválida do catálogo.');
      const normalize = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const companyIds = [...new Set(companies.results.filter(company => Number.isSafeInteger(company.id) && company.id > 0 && typeof company.name === 'string' && normalize(company.name).includes(normalize(text))).map(company => company.id))];
      if (companyIds.length) {
        const productions = await this.tmdb<{ results: TmdbItem[]; total_pages?: number }>(`discover/${kind === 'movie' ? 'movie' : 'tv'}`, { language, page: String(page), include_adult: 'false', with_companies: companyIds.join('|'), sort_by: kind === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc' });
        if (!Array.isArray(productions.results)) throw new BadGatewayException('Resposta inválida do catálogo.');
        results.push(...productions.results.filter(item => Number.isSafeInteger(item.id) && !item.adult).map(item => this.movie(item, kind as 'movie' | 'series')));
        if (page < Math.min(productions.total_pages || 0, 500)) nextPage = page + 1;
      }
      results = [...new Map(results.map(item => [item.catalogId, item])).values()];
    }
    const value = { results, nextPage };
    if (this.searchCache.size >= 500) this.searchCache.delete(this.searchCache.keys().next().value!);
    this.searchCache.set(key, { expires: Date.now() + 600000, value });
    return value;
  }
  async upcoming(catalogId: string, language: string) {
    if (!/^tmdb:series:[1-9]\d{0,14}$/.test(catalogId)) return { episode: null, ended: false, unsupported: true, stale: false };
    type Upcoming = { episode: { season: number; number: number; name: string; airDate: string } | null; ended: boolean };
    const collection = this.connection.collection<{ _id: string; value: Upcoming; expires: Date }>('series_upcoming');
    const key = catalogId + ':' + language;
    const cached = await collection.findOne({ _id: key });
    const today = new Date().toISOString().slice(0, 10);
    const current = (value: Upcoming) => ({ ...value, episode: value.episode && value.episode.airDate >= today ? value.episode : null });
    if (cached && cached.expires > new Date()) return { ...current(cached.value), stale: false, unsupported: false };
    try {
      const data = await this.tmdb<{ status: string; next_episode_to_air?: { season_number: number; episode_number: number; name: string; air_date: string } | null }>('tv/' + catalogId.split(':')[2], { language });
      const next = data.next_episode_to_air;
      const value: Upcoming = { ended: ['Ended', 'Canceled'].includes(data.status), episode: next && Number.isInteger(next.season_number) && next.season_number > 0 && Number.isInteger(next.episode_number) && next.episode_number > 0 && /^\d{4}-\d{2}-\d{2}$/.test(next.air_date || '') ? { season: next.season_number, number: next.episode_number, name: String(next.name || '').slice(0, 200), airDate: next.air_date } : null };
      await collection.updateOne({ _id: key }, { $set: { value, expires: new Date(Date.now() + 6 * 3600000) } }, { upsert: true });
      return { ...current(value), stale: false, unsupported: false };
    } catch (error) { if (cached) return { ...current(cached.value), stale: true, unsupported: false }; throw error; }
  }
  async seasons(catalogId: string) {
    if (!/^tmdb:series:[1-9]\d{0,14}$/.test(catalogId)) throw new BadRequestException('A série precisa estar vinculada ao TMDB.');
    const data = await this.tmdb<{ seasons: { season_number: number; name: string; episode_count: number }[] }>('tv/' + catalogId.split(':')[2]);
    if (!Array.isArray(data.seasons)) throw new BadGatewayException('O catálogo não retornou temporadas válidas.');
    return data.seasons.filter(season => Number.isInteger(season.season_number) && season.season_number >= 0).map(season => ({ number: season.season_number, name: String(season.name || 'Temporada ' + season.season_number).slice(0, 200), total: Math.max(0, season.episode_count || 0) }));
  }
  async seasonEpisodes(catalogId: string, season: number, language = 'pt-BR') {
    if (!/^tmdb:series:[1-9]\d{0,14}$/.test(catalogId) || !Number.isInteger(season) || season < 0 || season > 10000) throw new BadRequestException('Temporada inválida.');
    const data = await this.tmdb<{ episodes: { episode_number: number; name: string; air_date?: string; overview?: string; still_path?: string; runtime?: number }[] }>('tv/' + catalogId.split(':')[2] + '/season/' + season, { language });
    if (!Array.isArray(data.episodes)) throw new BadGatewayException('O catálogo não retornou episódios válidos.');
    return data.episodes.filter(episode => Number.isInteger(episode.episode_number) && episode.episode_number > 0).map(episode => ({ number: episode.episode_number, name: String(episode.name || 'Episódio ' + episode.episode_number).slice(0, 200), airDate: episode.air_date || '', overview: (episode.overview || '').slice(0, 2000), runtime: Number.isFinite(episode.runtime) ? episode.runtime : null, stillUrl: /^\/[A-Za-z0-9_.-]+$/.test(episode.still_path || '') ? 'https://image.tmdb.org/t/p/w780' + episode.still_path : '' }));
  }
  async detail(catalogId: string, language = 'pt-BR'): Promise<CatalogTitle> {
    const match = /^(tmdb):(movie|series):([1-9]\d{0,14})$|^(igdb):(game):([1-9]\d{0,14})$/.exec(catalogId);
    if (!match) throw new BadRequestException('Referência de catálogo inválida.');
    const detailKey = language === 'pt-BR' ? `detail:${catalogId}` : `detail:${catalogId}:${language}`;
    const cached = this.cached(detailKey); if (cached) return cached[0];
    let item: CatalogTitle;
    if (catalogId.startsWith('tmdb:')) {
      const kind = match[2] as 'movie' | 'series'; const id = match[3];
      const data = await this.tmdb<TmdbItem>(`${kind === 'movie' ? 'movie' : 'tv'}/${id}`, { language });
      if (data.adult || !Number.isSafeInteger(data.id)) throw new BadRequestException('Título indisponível.');
      item = this.movie(data, kind);
    } else {
      const data = await this.igdb(`fields name,summary,first_release_date,cover.image_id,slug,genres.name,platforms.name,platforms.abbreviation,game_localizations.name,game_localizations.region.identifier; where id = ${match[6]}; limit 1;`);
      if (!Array.isArray(data) || !data[0] || typeof data[0].name !== 'string') throw new BadRequestException('Jogo não encontrado.');
      item = this.game(data[0], language);
    }
    if (item.catalogId !== catalogId) throw new BadGatewayException('O catálogo retornou uma referência diferente da solicitada.');
    this.remember(detailKey, [item]); return item;
  }
}
@ApiTags('catalog')
@ApiCookieAuth('session')
@Controller('catalog')
class CatalogController {
  constructor(private readonly service: CatalogService, private readonly auth: AuthService) {}
  private async authorize(request: Request) { const raw: unknown = request.cookies?.[getConfig().cookieName]; return this.auth.me(typeof raw === 'string' ? raw : undefined); }
  @Get('providers') async providers(@Req() request: Request) { await this.authorize(request); return this.service.available(); }
  @Get('suggestions') async suggestions(@Req() request: Request, @Query('kind') kind: string, @Query('page') page?: string, @Query('platform') platform?: string) { const user = await this.authorize(request); this.service.limit(user.id); return this.service.suggestions(kind, user.id, user.language, page === undefined ? 1 : Number(page), platform === undefined ? undefined : Number(platform)); }
  @Get('search') async search(@Req() request: Request, @Query('kind') kind: string, @Query('q') query: string, @Query('page') page?: string, @Query('platform') platform?: string) { const user = await this.authorize(request); this.service.limit(user.id); return this.service.search(kind, query, user.language, page === undefined ? 1 : Number(page), platform === undefined ? undefined : Number(platform)); }
}
@Module({ imports: [AuthModule], controllers: [CatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
