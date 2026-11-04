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
    return { results: [{ id: 1, title: 'Filme', genre_ids: [28] }], total_pages: 3 };
  };
  const data = await service.browse('movie', 'pt-BR', 2, '28,12', 'Marvel');
  assert.equal(data.nextPage, 3);
  assert.deepEqual(data.results[0].genres, ['Ação']);
  assert.equal(calls.at(-1).path, 'discover/movie');
  assert.equal(calls.at(-1).params.with_genres, '28|12');
  assert.equal(calls.at(-1).params.with_companies, '420');
  assert.equal(calls.at(-1).params.page, '2');
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
});

test('jogos recebem filtro de gêneros e plataforma antes da paginação', async () => {
  const service = new CatalogService({});
  service.genres = async () => [{ id: 12, name: 'RPG' }, { id: 31, name: 'Adventure' }];
  service.igdb = async query => {
    assert.match(query, /genres = \(12,31\)/);
    assert.match(query, /platforms = \(167\)/);
    assert.match(query, /offset 20/);
    return Array.from({ length: 21 }, (_, i) => ({ id: i + 1, name: 'Game' }));
  };
  const data = await service.browse('game', 'pt-BR', 2, '12,31', '', '', 167);
  assert.equal(data.results.length, 20);
  assert.equal(data.nextPage, 3);
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
