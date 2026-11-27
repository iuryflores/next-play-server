const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { CatalogService } = require('../dist/catalog/catalog.module');

test('descoberta combina gêneros OU e produtora com paginação no provedor', async () => {
  const service = new CatalogService({});
  const calls = [];
  service.tmdb = async (path, params) => {
    calls.push({ path, params });
    if (path.startsWith('genre/')) return { genres: [{ id: 28, name: 'Ação' }, { id: 12, name: 'Aventura' }] };
    if (path === 'search/company') return { results: [{ id: 420, name: 'Marvel Studios' }, { id: 99, name: 'Outra empresa' }] };
    return { results: [{ id: 1, title: 'Filme', release_date: '2020-12-31', genre_ids: [28] }], total_pages: 3 };
  };
  const data = await service.browse('movie', 'pt-BR', 2, '28,12', 'Marvel', '', undefined, '2020');
  assert.equal(data.nextPage, 3);
  assert.deepEqual(data.results[0].genres, ['Ação']);
  assert.equal(calls.at(-1).path, 'discover/movie');
  assert.equal(calls.at(-1).params.with_genres, '28|12');
  assert.equal(calls.at(-1).params.with_companies, '420');
  assert.equal(calls.at(-1).params.page, '2');
  assert.equal(calls.at(-1).params.primary_release_year, '2020');
});

test('produtora inexistente não amplia a consulta', async () => {
  const service = new CatalogService({});
  service.genres = async () => [];
  service.tmdb = async path => { assert.equal(path, 'search/company'); return { results: [] }; };
  assert.deepEqual(await service.browse('series', 'pt-BR', 1, '', 'Inexistente'), { results: [], nextPage: null });
});

test('busca textual verifica gêneros e produtora nos detalhes, preservando próxima página vazia', async () => {
  const service = new CatalogService({});
  service.genres = async () => [{ id: 28, name: 'Ação' }, { id: 35, name: 'Comédia' }];
  service.tmdb = async () => ({ results: [{ id: 420, name: 'Marvel Studios' }] });
  service.search = async () => ({ results: [{ catalogId: 'tmdb:movie:1' }, { catalogId: 'tmdb:movie:2' }], nextPage: 2 });
  service.detail = async id => ({ catalogId: id, genres: [id.endsWith(':1') ? 'Ação' : 'Comédia'], productionCompanies: [{ id: 420 }] });
  const data = await service.browse('movie', 'pt-BR', 1, '28', 'Marvel', 'Filme');
  assert.deepEqual(data.results.map(row => row.catalogId), ['tmdb:movie:1']);
  assert.equal(data.nextPage, 2);
  service.detail = async id => ({ catalogId: id, genres: ['Ação'], productionCompanies: [{ id: 99 }] });
  const empty = await service.browse('movie', 'pt-BR', 1, '28', 'Marvel', 'Filme');
  assert.deepEqual(empty.results, []);
  assert.equal(empty.nextPage, 2);
});

test('valida entrada antes de consultar provedores e rejeita gênero de outra categoria', async () => {
  const service = new CatalogService({});
  service.genres = async () => [{ id: 28, name: 'Ação' }];
  service.tmdb = async () => assert.fail('entrada inválida não pode chegar ao provedor');
  for (const genres of ['0', '-1', '28|12', '1;drop', '1,2,3,4,5,6,7,8,9', '999']) {
    await assert.rejects(service.browse('movie', 'pt-BR', 1, genres), /gênero/i);
  }
  await assert.rejects(service.browse('game', 'pt-BR', 1, '', 'Marvel'), /produtora/i);
  await assert.rejects(service.browse('movie', 'pt-BR', 501), /página/i);
  await assert.rejects(service.browse('movie', 'pt-BR', 1, '', '', 'a'), /Busca/);
  for (const year of ['', '0200', '202', '2020.0', ' 2020', ['2020', '2021']]) {
    await assert.rejects(service.browse('movie', 'pt-BR', 1, '', '', '', undefined, year), /ano de lançamento/);
  }
});

test('jogos recebem filtro de gêneros e plataforma antes da paginação', async () => {
  const service = new CatalogService({});
  service.genres = async () => [{ id: 12, name: 'RPG' }, { id: 31, name: 'Adventure' }];
  service.igdb = async query => {
    assert.match(query, /genres = \(12,31\)/);
    assert.match(query, /platforms = \(167\)/);
    assert.match(query, /first_release_date >= 1577836800 & first_release_date < 1609459200/);
    assert.match(query, /offset 20/);
    return Array.from({ length: 21 }, (_, i) => ({ id: i + 1, name: 'Game', first_release_date: 1609459199 }));
  };
  const data = await service.browse('game', 'pt-BR', 2, '12,31', '', '', 167, '2020');
  assert.equal(data.results.length, 20);
  assert.equal(data.nextPage, 3);
});

test('séries usam a estreia em descoberta e busca textual, com cache separado por ano', async () => {
  const service = new CatalogService({});
  service.genres = async () => [];
  const calls = [];
  service.tmdb = async (path, params) => {
    if (path === 'search/company') return { results: [] };
    calls.push({ path, params });
    return { results: [
      { id: 1, name: 'Série', first_air_date: '2020-01-01', release_date: '2021-01-01' },
      { id: 2, name: 'Série sem estreia', release_date: '2020-01-01' },
      { id: 3, name: 'Outra série', first_air_date: '2021-01-01' },
    ], total_pages: 2 };
  };
  const ids = data => data.results.map(row => row.catalogId);
  assert.deepEqual(ids(await service.browse('series', 'pt-BR', 1, '', '', '', undefined, '2020')), ['tmdb:series:1']);
  assert.deepEqual(ids(await service.browse('series', 'pt-BR', 1, '', '', 'Série', undefined, '2020')), ['tmdb:series:1']);
  assert.deepEqual(ids(await service.browse('series', 'pt-BR', 1, '', '', 'Série', undefined, '2021')), ['tmdb:series:3']);
  assert.deepEqual(calls.map(({ path, params }) => [path, params.first_air_date_year]),
    [['discover/tv', '2020'], ['search/tv', '2020'], ['search/tv', '2021']]);
});

test('busca textual de jogos combina plataforma e ano e preserva o cursor', async () => {
  const service = new CatalogService({});
  service.genres = async () => [];
  service.igdb = async query => {
    assert.match(query, /search "zelda"/);
    assert.match(query, /where platforms = \(130\) & first_release_date >= 1577836800 & first_release_date < 1609459200/);
    return Array.from({ length: 21 }, (_, i) => ({ id: i + 1, name: 'Zelda', first_release_date: 1609459200 }));
  };
  assert.deepEqual(await service.browse('game', 'pt-BR', 1, '', '', 'zelda', 130, '2020'), { results: [], nextPage: 2 });
});

test('filtro de crítica de jogos usa a média externa e conserva a nota ao buscar detalhes por gênero', async () => {
  const service = new CatalogService({});
  service.genres = async () => [{ id: 12, name: 'RPG' }];
  service.igdb = async query => {
    assert.match(query, /aggregated_rating_count > 0 & aggregated_rating >= 80/);
    assert.match(query, /platforms = \(130\).*first_release_date/);
    return [
      { id: 1, name: 'RPG', first_release_date: 1577836800, aggregated_rating: 88, rating: 40 },
      { id: 2, name: 'RPG', first_release_date: 1577836800, rating: 100 },
    ];
  };
  service.detail = async catalogId => ({ catalogId, kind: 'game', year: '2020', genres: ['RPG'] });
  for (const term of ['', 'RPG']) {
    const data = await service.browse('game', 'pt-BR', 1, '12', '', term, 130, '2020', { source: 'critic', minimum: 80 });
    assert.deepEqual(data.results.map(row => [row.catalogId, row.rating]), [['igdb:game:1', 88]]);
  }
});

test('diretório de gêneros isola cache por idioma e categoria', async () => {
  const service = new CatalogService({});
  let count = 0;
  service.tmdb = async (_, params) => { count++; return { genres: [{ id: 28, name: params.language }] }; };
  await service.genres('movie', 'pt-BR');
  await service.genres('movie', 'pt-BR');
  await service.genres('series', 'pt-BR');
  await service.genres('movie', 'en-US');
  assert.equal(count, 3);
});

test('streaming aplica assinatura por país com serviços em OU e outros filtros em E', async () => {
  const service = new CatalogService({});
  service.genres = async () => [{ id: 18, name: 'Drama' }];
  const calls = [];
  service.tmdb = async (path, params) => {
    calls.push({ path, params });
    if (path === 'watch/providers/tv') return { results: [
      { provider_id: 8, provider_name: 'Netflix' }, { provider_id: 119, provider_name: 'Prime Video' },
    ] };
    if (path === 'search/company') return { results: [{ id: 420, name: 'Produtora' }] };
    return { results: [{ id: 1, name: 'Série', first_air_date: '2020-01-01', genre_ids: [18] }], total_pages: 3 };
  };
  service.availability = async () => ({ groups: [{ type: 'flatrate', providers: [{ id: 8 }] }] });
  const filter = { country: 'BR', ids: [8, 119], types: ['flatrate'] };
  const page = await service.browse('series', 'pt-BR', 2, '18', 'Produtora', '', undefined, '2020', undefined, filter);
  assert.equal(page.nextPage, 3);
  assert.deepEqual(calls.at(-1), { path: 'discover/tv', params: {
    language: 'pt-BR', page: '2', include_adult: 'false', sort_by: 'popularity.desc',
    with_genres: '18', with_companies: '420', first_air_date_year: '2020',
    watch_region: 'BR', with_watch_providers: '8|119', with_watch_monetization_types: 'flatrate',
  } });
  await assert.rejects(service.browse('series', 'pt-BR', 1, '', '', '', undefined, undefined, undefined,
    { ...filter, ids: [999] }), /streaming inválido/);
  assert.equal(calls.filter(call => call.path === 'watch/providers/tv').length, 1);
});

test('busca textual valida assinatura do serviço certo e preserva o cursor de páginas vazias', async () => {
  const service = new CatalogService({});
  service.genres = async () => [];
  service.streamingProviders = async () => [{ id: 8, name: 'Netflix' }, { id: 119, name: 'Prime Video' }];
  service.search = async () => ({ results: [1, 2, 3].map(id => ({ catalogId: 'tmdb:movie:' + id })), nextPage: 2 });
  service.availability = async (id, country) => {
    assert.equal(country, 'PT');
    if (id.endsWith(':1')) return { groups: [{ type: 'rent', providers: [{ id: 8 }] }] };
    if (id.endsWith(':2')) return { groups: [{ type: 'flatrate', providers: [{ id: 119 }] }] };
    return { groups: [{ type: 'flatrate', providers: [{ id: 50 }] }] };
  };
  const filter = { country: 'PT', ids: [8, 119], types: ['flatrate'] };
  const first = await service.browse('movie', 'pt-BR', 1, '', '', 'Filme', undefined, undefined, undefined, filter);
  assert.deepEqual(first, { results: [{ catalogId: 'tmdb:movie:2' }], nextPage: 2 });
  assert.deepEqual(await service.browse('movie', 'pt-BR', 1, '', '', 'Filme', undefined, undefined, undefined,
    { ...filter, ids: [8] }), { results: [], nextPage: 2 });
});

test('formas de acesso aceitam qualquer serviço ou exigem que a oferta pertença ao serviço escolhido', async () => {
  const service = new CatalogService({});
  service.genres = async () => [];
  service.streamingProviders = async () => [{ id: 8, name: 'Netflix' }];
  service.tmdb = async (_, params) => {
    assert.equal(params.with_watch_monetization_types, 'free|ads|rent|buy');
    return { results: [1, 2].map(id => ({ id, title: 'Filme' })), total_pages: 2 };
  };
  service.availability = async id => ({ groups: [
    { type: 'flatrate', providers: [{ id: 8 }] },
    { type: id.endsWith(':1') ? 'rent' : 'ads', providers: [{ id: id.endsWith(':1') ? 119 : 8 }] },
  ] });
  const filter = { country: 'BR', types: ['free', 'ads', 'rent', 'buy'] };
  const browse = ids => service.browse('movie', 'pt-BR', 1, '', '', '', undefined, undefined, undefined, { ...filter, ids });
  assert.deepEqual((await browse([])).results.map(row => row.catalogId), ['tmdb:movie:1', 'tmdb:movie:2']);
  const selected = await browse([8]);
  assert.deepEqual(selected.results.map(row => row.catalogId), ['tmdb:movie:2']);
  assert.equal(selected.nextPage, 2);
});

test('origem combina idioma, país de origem, ano de estreia e região de streaming independente', async () => {
  const service = new CatalogService({});
  service.genres = async () => [{ id: 18, name: 'Drama' }];
  service.tmdb = async (path, params) => {
    assert.equal(path, 'discover/tv');
    assert.equal(params.with_original_language, 'fr');
    assert.equal(params.with_origin_country, 'CA');
    assert.equal(params.watch_region, 'BR');
    assert.equal(params.with_watch_monetization_types, 'free|ads');
    assert.equal(params.with_genres, '18');
    assert.equal(params.first_air_date_year, '2020');
    return { results: [{ id: 1, name: 'Série', first_air_date: '2020-01-01' }], total_pages: 2 };
  };
  const origin = { originalLanguage: 'fr', originCountry: 'CA' };
  assert.equal((await service.browse('series', 'pt-BR', 1, '18', '', '', undefined, '2020', undefined,
    { country: 'BR', ids: [], types: ['free', 'ads'] }, origin)).nextPage, 2);
  await assert.rejects(service.browse('game', 'pt-BR', 1, '', '', '', undefined, undefined, undefined, undefined, origin), /idioma original/);
});

test('busca textual usa origem da série e detalhes quando faltam países do filme', async () => {
  const service = new CatalogService({});
  service.genres = async () => [];
  service.search = async () => ({ results: [
    { catalogId: 'tmdb:movie:1', originalLanguage: 'fr' },
    { catalogId: 'tmdb:movie:2', originalLanguage: 'en' },
    { catalogId: 'tmdb:series:3', originalLanguage: 'fr', originCountries: ['FR', 'CA'] },
  ], nextPage: 2 });
  service.detail = async id => {
    assert.equal(id, 'tmdb:movie:1');
    return { catalogId: id, originalLanguage: 'fr', originCountries: ['BE'] };
  };
  const data = await service.browse('series', 'pt-BR', 1, '', '', 'Teste', undefined, undefined, undefined, undefined,
    { originalLanguage: 'fr', originCountry: 'CA' });
  assert.deepEqual(data.results.map(row => row.catalogId), ['tmdb:series:3']);
  assert.equal(data.nextPage, 2);
});

test('classificação brasileira aplica o máximo inclusivo, considera todos os lançamentos e mantém o cursor', async () => {
  const service = new CatalogService({});
  service.genres = async () => [];
  let classificationRequests = 0;
  service.tmdb = async path => {
    if (path === 'discover/movie') return { results: [1, 2, 3, 4].map(id => ({ id, title: 'Filme' })), total_pages: 2 };
    classificationRequests++;
    if (path === 'movie/1/release_dates') return { results: [{ iso_3166_1: 'BR', release_dates: [{ certification: '6' }, { certification: '12' }] }] };
    if (path === 'movie/2/release_dates') return { results: [{ iso_3166_1: 'BR', release_dates: [{ certification: 'L' }, { certification: '14' }] }] };
    if (path === 'movie/3/release_dates') return { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'G' }] }] };
    if (path === 'movie/4/release_dates') return { results: [{ iso_3166_1: 'BR', release_dates: [{ certification: 'Livre' }] }] };
    assert.fail('Consulta inesperada: ' + path);
  };
  const browse = maxAge => service.browse('movie', 'pt-BR', 1, '', '', '', undefined, undefined, undefined, undefined, {}, maxAge);
  const page = await browse('12');
  assert.deepEqual(page.results.map(row => [row.catalogId, row.ageRating]), [['tmdb:movie:1', 12], ['tmdb:movie:4', 0]]);
  assert.equal(page.nextPage, 2);
  assert.deepEqual((await browse('0')).results.map(row => row.catalogId), ['tmdb:movie:4']);
  assert.equal(classificationRequests, 4);
  await assert.rejects(browse('13'), /classificação indicativa/);
});

test('classificação de séries consulta somente o registro brasileiro', async () => {
  const service = new CatalogService({});
  service.genres = async () => [];
  service.search = async () => ({ results: [{ catalogId: 'tmdb:series:1' }], nextPage: 2 });
  service.tmdb = async path => {
    assert.equal(path, 'tv/1/content_ratings');
    return { results: [{ iso_3166_1: 'PT', rating: '18' }, { iso_3166_1: 'BR', rating: '6' }] };
  };
  const result = await service.browse('series', 'pt-BR', 1, '', '', 'Série', undefined, undefined,
    undefined, undefined, {}, '6');
  assert.deepEqual(result, { results: [{ catalogId: 'tmdb:series:1', ageRating: 6 }], nextPage: 2 });
  await assert.rejects(service.browse('game', 'pt-BR', 1, '', '', '', undefined, undefined,
    undefined, undefined, {}, '6'), /filmes e séries/);
});

test('coleção de filmes inclui membros com outros nomes e combina universo e ano', async () => {
  const service = new CatalogService({});
  service.genres = async () => [];
  service.tmdb = async (path, params) => {
    if (path === 'search/keyword') {
      assert.equal(params.query, 'Marvel Cinematic Universe');
      return { results: [{ id: 88, name: 'marvel cinematic universe (mcu)' }] };
    }
    if (path === 'search/collection') return { results: [{ id: 3, name: 'Thor Collection' }] };
    if (path === 'collection/3') return { parts: [
      { id: 10, title: 'Ragnarok', release_date: '2017-01-01' },
      { id: 11, title: 'Outro membro', release_date: '2017-01-01' },
      { id: 12, title: 'Lançamento de outro ano', release_date: '2020-01-01' },
    ] };
    if (path === 'movie/10/keywords') return { keywords: [{ id: 88 }] };
    if (path === 'movie/11/keywords') return { keywords: [] };
    assert.fail(path);
  };
  const filter = { franchise: 'Thor', universe: 'UCM' };
  const result = await service.browse('movie', 'pt-BR', 1, '', '', '', undefined, '2017', undefined, undefined, {}, undefined, filter);
  assert.deepEqual(result.results.map(row => row.catalogId), ['tmdb:movie:10']);
});

test('franquia de jogos combina vínculo IGDB com plataforma antes de paginar', async () => {
  const service = new CatalogService({});
  service.genres = async () => [];
  service.igdb = async (body, endpoint) => {
    if (endpoint === 'franchises') {
      assert.match(body, /where name ~ \*"Zelda"\*/);
      return [{ id: 32 }];
    }
    assert.match(body, /platforms = \(130\) & \(franchise = \(32\) \| franchises = \(32\)\)/);
    assert.match(body, /offset 20/);
    return [{ id: 8, name: 'Jogo' }];
  };
  const result = await service.browse('game', 'pt-BR', 2, '', '', '', 130, undefined, undefined, undefined, {}, undefined, { franchise: 'Zelda' });
  assert.deepEqual(result.results.map(row => row.catalogId), ['igdb:game:8']);
});

test('franquia e universo de séries exigem ambas as etiquetas exatas do TMDB', async () => {
  const service = new CatalogService({});
  service.genres = async () => [];
  service.tmdb = async (path, params) => {
    if (path === 'search/keyword') {
      return { results: [{ id: 99, name: params.query + ' fan' },
        { id: params.query === 'Star Wars' ? 20 : 21, name: params.query.toLowerCase() }] };
    }
    assert.equal(path, 'discover/tv');
    assert.equal(params.with_keywords, '20,21');
    return { results: [{ id: 5, name: 'Série' }], total_pages: 2 };
  };
  const result = await service.browse('series', 'pt-BR', 1, '', '', '', undefined, undefined,
    undefined, undefined, {}, undefined, { franchise: 'Guerra nas Estrelas', universe: 'Universo exemplo' });
  assert.deepEqual(result.results.map(row => row.catalogId), ['tmdb:series:5']);
  assert.equal(result.nextPage, 2);
});
