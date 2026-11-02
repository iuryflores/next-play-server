require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CatalogService } = require('../dist/catalog/catalog.module');

test('filmes e séries consultam populares nos gêneros do dono e mantêm afinidade antes da ordem do provedor', async () => {
  const owned = [{genres:['Ação'],catalogId:'tmdb:movie:999',title:'Meu filme'}];
  const connection = {collection:()=>({find:()=>({sort:()=>({toArray:async()=>owned})})})};
  const service = new CatalogService(connection);
  const calls = [];
  service.tmdb = async (path, params) => {
    calls.push({path,params});
    if(path.startsWith('genre/')) return {genres:[{id:28,name:'Ação'},{id:18,name:'Drama'}]};
    return {total_pages:50,results:[
      {id:1,title:'Drama popular',name:'Drama popular',genre_ids:[18]},
      {id:2,title:'Ação mais popular',name:'Ação mais popular',genre_ids:[28]},
      {id:3,title:'Outra ação',name:'Outra ação',genre_ids:[28]},
    ]};
  };
  for(const kind of ['movie','series']) {
    const result = await service.suggestions(kind,'111111111111111111111111','pt-BR',1);
    assert.deepEqual(result.results.map(item=>item.title),['Ação mais popular','Outra ação','Drama popular']);
    const query = calls.find(call=>call.path===`discover/${kind==='movie'?'movie':'tv'}`);
    assert.equal(query.params.with_genres,'28');
    assert.equal(query.params.sort_by,'popularity.desc');
    assert.equal(query.params.language,'pt-BR');
  }
});
test('suggestion pages advance, cache separately and stop at the end', async () => {
  const service = new CatalogService();
  const calls = [];
  service.tmdb = async (path, params) => {
    calls.push({ path, ...params });
    return { results: Array.from({ length: params.page === '1' ? 20 : 3 }, (_, i) => ({ id: Number(params.page) * 100 + i, title: 'Movie ' + i })) };
  };
  const first = await service.suggestions('movie', undefined, 'en-US', 1);
  const second = await service.suggestions('movie', undefined, 'en-US', 2);
  assert.equal(first.nextPage, 2); assert.equal(second.nextPage, null);
  assert.ok(second.results.every(item => !first.results.some(previous => previous.catalogId === item.catalogId)));
  await service.suggestions('movie', undefined, 'en-US', 2);
  assert.equal(calls.length, 2); assert.equal(calls[1].page, '2'); assert.equal(calls[1].language, 'en-US');
  await service.suggestions('series', undefined, 'es-ES', 1);
  assert.equal(calls[2].path, 'tv/popular');
  const queries = [];
  service.igdb = async body => { queries.push(body); return Array.from({ length: body.includes('offset 0;') ? 20 : 0 }, (_, id) => ({ id: id + 1, name: 'Game ' + id })); };
  assert.equal((await service.suggestions('game', undefined, 'en-US', 1)).nextPage, 2);
  assert.equal((await service.suggestions('game', undefined, 'en-US', 2)).nextPage, null);
  assert.match(queries[1], /offset 20;/);
  for (const page of [0, -1, 1.5, 501, NaN]) await assert.rejects(() => service.suggestions('movie', undefined, 'en-US', page), error => error.getStatus() === 400);
});

test('total real de páginas é preservado no cache e limitado ao teto do TMDB',async()=>{
 const service=new CatalogService();let calls=0;let total=17;
 service.tmdb=async(path,params)=>{calls++;return {total_pages:total,results:[{id:Number(params.page),title:'Título da página '+params.page}]};};
 const first=await service.suggestions('movie',undefined,'pt-BR',1);
 assert.equal(first.totalPages,17);assert.equal(first.nextPage,2);
 const cached=await service.suggestions('movie',undefined,'pt-BR',1);
 assert.equal(cached.totalPages,17);assert.equal(calls,1);
 assert.equal((await service.suggestions('movie',undefined,'pt-BR',17)).nextPage,null);
 total=999;assert.equal((await service.suggestions('series',undefined,'pt-BR',1)).totalPages,500);
 assert.equal((await service.suggestions('series',undefined,'pt-BR',500)).nextPage,null);
});
