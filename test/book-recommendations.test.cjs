require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { BooksService } = require('../dist/books/books.module');
const { alreadyOwned, bookAffinity, bookPreferences } = require('../dist/books/book-recommendations');

const a = new Types.ObjectId(), b = new Types.ObjectId();
const classic = { title: 'Dom Casmurro', authors: ['Machado de Assis'], catalogId: 'googlebooks:book:owned', genres: ['Fiction / Classics'], publisher: 'Editora Rocco', language: 'pt-BR', bookMetadataVersion: 1 };
const volume = (id, title, genre, publisher = 'Outra editora') => ({ id, volumeInfo: { title, authors: genre.includes('Horror') ? ['Autor de terror'] : ['Autor de teste'], categories: [genre], publisher, language: 'pt-BR' } });

test('cópias repetidas não aumentam preferência; editora precede gênero isolado', () => {
  const profile = bookPreferences([classic, { ...classic, authors: ['de Assis, Machado'], catalogId: 'googlebooks:book:otherEdition' }]);
  assert.equal(profile.genres[0].count, 1); assert.equal(profile.publishers[0].count, 1);
  assert.equal(profile.language, 'pt');
  assert.ok(bookAffinity({ publisher: 'Rocco' }, profile) > bookAffinity({ genres: ['Fiction / Classics'] }, profile));
  assert.ok(bookAffinity({ publisher: 'Rocco' }, profile) > 0);
  assert.equal(bookAffinity({ genres: ['Fiction / Horror'] }, profile), 0);
  assert.ok(alreadyOwned({ ...classic, catalogId: 'googlebooks:book:otherEdition' }, [classic]));
  assert.ok(alreadyOwned({ ...classic, authors: ['de Assis, Machado'], catalogId: 'googlebooks:book:otherEdition' }, [classic]));
  assert.equal(alreadyOwned({ title: classic.title, authors: ['Outro autor'] }, [classic]), false);
});

function fakeConnection(rows, expectedCollection = 'collector_copies') {
  const filters = [], updates = [];
  return { filters, updates, connection: { collection(name) {
    assert.equal(name, expectedCollection);
    return {
      find(filter) { filters.push(filter); return { sort() { return { async toArray() { return rows.filter(row => row.ownerId.equals(filter.ownerId) && row.kind === filter.kind).map(row => ({ ...row })); } }; } }; },
      async updateMany(filter, update) {
        updates.push({ filter, update });
        for (const row of rows) if (row.ownerId.equals(filter.ownerId) && row.kind === filter.kind && row.catalogId === filter.catalogId && row.bookMetadataVersion !== 1) Object.assign(row, update.$set);
      },
    };
  } } };
}
test('cache público não mistura preferências, posse ou dados de outros usuários', async () => {
  const db = fakeConnection([{ ...classic, ownerId: a, kind: 'book' }, { ...classic, title: 'Livro de terror', authors: ['Autor de terror'], catalogId: 'googlebooks:book:horror', genres: ['Fiction / Horror'], publisher: 'Darkside', ownerId: b, kind: 'book' }]);
  const service = new BooksService(db.connection); const queries = [];
  service.request = async (_path, params) => {
    queries.push(params.q);
    const horror = /Horror|Darkside/.test(params.q);
    return { kind: 'books#volumes', totalItems: 3, items: [
      volume('owned', 'Dom Casmurro', 'Fiction / Classics', 'Rocco'),
      volume('classic', 'Outro clássico', 'Fiction / Classics', 'Rocco'),
      volume('horror', 'Livro de terror', 'Fiction / Horror', 'Darkside'),
      volume('newHorror', 'Outro terror', 'Fiction / Horror', 'Darkside'),
    ].filter(v => horror ? /horror|Horror/.test(v.id) : true) };
  };
  const first = await service.suggestions(1, a.toString());
  assert.equal(first.personalized, true); assert.deepEqual(first.results.map(book => book.title), ['Outro clássico']);
  const calls = queries.length;
  assert.deepEqual(await service.suggestions(1, a.toString()), first); assert.equal(queries.length, calls);
  const second = await service.suggestions(1, b.toString());
  assert.equal(second.personalized, true); assert.deepEqual(second.results.map(book => book.title), ['Outro terror']);
  assert.ok(queries.some(q => q.includes('Darkside'))); assert.ok(queries.some(q => q.startsWith('inauthor:')));
  assert.ok(db.filters.every(filter => filter.kind === 'book' && filter.ownerId instanceof Types.ObjectId));
});
test('remoção/adição do acervo muda as sugestões mesmo quando os candidatos estão em cache', async () => {
  const rows = [{ ...classic, ownerId: a, kind: 'book' }];
  const service = new BooksService(fakeConnection(rows).connection);
  service.request = async () => ({ kind: 'books#volumes', totalItems: 1, items: [volume('new', 'Outro clássico', 'Fiction / Classics', 'Rocco')] });
  assert.equal((await service.suggestions(1, a.toString())).results.length, 1);
  rows.push({ ...classic, title: 'Outro clássico', catalogId: 'googlebooks:book:new', ownerId: a, kind: 'book' });
  assert.equal((await service.suggestions(1, a.toString())).results.length, 0);
  rows.pop(); assert.equal((await service.suggestions(1, a.toString())).results.length, 1);
});
test('metadados antigos são recuperados de até dois volumes sem alterar datas/edições ou outros usuários', async () => {
  const date = new Date('2026-01-01');
  const rows = Array.from({ length: 3 }, (_, i) => ({ ...classic, title: 'Antigo ' + i, catalogId: 'googlebooks:book:old' + i, genres: undefined, bookMetadataVersion: undefined, ownerId: a, kind: 'book', updatedAt: date, edition: 'Capa dura', notes: 'Privado' }));
  rows.push({ ...rows[0], ownerId: b });
  const db = fakeConnection(rows), service = new BooksService(db.connection); let details = 0;
  service.detail = async id => { details++; return { ...classic, catalogId: id, genres: ['Fiction / Classics'] }; };
  service.request = async () => ({ kind: 'books#volumes', totalItems: 1, items: [volume('new', 'Outro clássico', 'Fiction / Classics')] });
  assert.equal((await service.suggestions(1, a.toString())).personalized, true);
  assert.equal(details, 2); assert.equal(db.updates.length, 2);
  assert.equal(rows[3].bookMetadataVersion, undefined);
  for (const row of rows) { assert.equal(row.edition, 'Capa dura'); assert.equal(row.notes, 'Privado'); assert.equal(row.updatedAt, date); }
});
test('sem metadados retorna seleção geral; falha em uma fonte preserva a outra e falha total é explícita', async () => {
  const service = new BooksService(fakeConnection([]).connection);
  service.request = async () => ({ kind: 'books#volumes', totalItems: 1, items: [volume('general', 'Livro geral', 'Fiction')] });
  assert.equal((await service.suggestions(1, a.toString())).personalized, false);
  const related = new BooksService(fakeConnection([{ ...classic, ownerId: a, kind: 'book' }]).connection);
  related.request = async (_path, params) => { if (params.q.startsWith('intitle:') || params.q.startsWith('inauthor:')) throw new Error('temporário'); return { kind: 'books#volumes', totalItems: 1, items: [volume('new', 'Mesma editora', 'Other', 'Rocco')] }; };
  assert.equal((await related.suggestions(1, a.toString())).personalized, true);
  const failed = new BooksService(fakeConnection([{ ...classic, ownerId: a, kind: 'book' }]).connection);
  failed.request = async () => { throw new Error('temporário'); };
  await assert.rejects(failed.suggestions(1, a.toString()), /temporário/);
});
test('Game of Thrones e George R. R. Martin precedem LeYa sem preencher com editora apenas', async () => {
  const seed = { title: 'Game of Thrones', authors: ['George R. R. Martin'], publisher: 'LeYa', language: 'pt-BR', genres: ['Fiction / Fantasy'], catalogId: 'googlebooks:book:owned', bookMetadataVersion: 1, ownerId: a, kind: 'book' };
  const profile = bookPreferences([seed, ...Array.from({ length: 200 }, (_, i) => ({ ...seed, title: 'Outro livro ' + i, authors: ['Autor ' + i] }))]);
  const sequel = { title: 'Game of Thrones: continuação', authors: ['Outro autor'], language: 'en' };
  const martin = { title: 'A Knight of the Seven Kingdoms', authors: ['George R.R. Martin'], language: 'en' };
  const leya = { title: 'Livro sem relação', publisher: 'LeYa', language: 'pt-BR' };
  assert.ok(bookAffinity(sequel, profile) > bookAffinity(martin, profile));
  assert.ok(bookAffinity(martin, profile) > bookAffinity(leya, profile), 'nem 200 obras da editora ultrapassam o autor');
  const service = new BooksService(fakeConnection([seed]).connection); const queries = [];
  service.request = async (_path, params) => {
    queries.push(params.q);
    return { kind: 'books#volumes', totalItems: 3, items: [sequel, martin, leya].map((book, i) => ({ id: 'candidate' + i, volumeInfo: { ...book, categories: ['Fiction / Fantasy'] } })) };
  };
  const result = await service.suggestions(1, a.toString(), 'collection', 'en-US');
  assert.equal(result.personalized, true);
  assert.deepEqual(result.results.map(book => book.title), [sequel.title, martin.title]);
  assert.ok(queries.some(q => q.startsWith('intitle:'))); assert.ok(queries.some(q => q.includes('George R. R. Martin')));
});

test('idioma do perfil prevalece sobre livros salvos e cache separa pt/en/es com filtragem local',async()=>{
  const seed={...classic,language:'en',ownerId:a,kind:'book'};
  const service=new BooksService(fakeConnection([seed]).connection);const requests=[];
  const titles={pt:'Outro clássico em português',en:'Another classic',es:'Otro clásico'};
  service.request=async(_path,params)=>{
    requests.push(params.langRestrict);
    return {kind:'books#volumes',totalItems:5,items:[
      ...Object.entries(titles).map(([language,title])=>({id:'edition_'+language,volumeInfo:{title,authors:classic.authors,publisher:'Rocco',language}})),
      {id:'unknown',volumeInfo:{title:'Sem idioma',authors:classic.authors}},
      {id:'invalid',volumeInfo:{title:'Idioma inválido',authors:classic.authors,language:123}},
    ]};
  };
  for(const[locale,code]of [['pt-BR','pt'],['en-US','en'],['es-ES','es']]){
    const before=requests.length;
    const result=await service.suggestions(1,a.toString(),'collection',locale);
    assert.equal(result.personalized,true);assert.deepEqual(result.results.map(book=>book.title),[titles[code]]);
    assert.ok(result.results.every(book=>book.language===code));assert.ok(requests.slice(before).every(value=>value===code));
  }
  const previous=requests.length;
  assert.equal((await service.suggestions(1,a.toString(),'collection','pt-BR')).results[0].language,'pt');assert.equal(requests.length,previous);
});

test('sugestões gerais sem histórico também seguem o idioma solicitado',async()=>{
  const service=new BooksService();const requests=[];
  service.request=async(_path,params)=>{requests.push(params.langRestrict);return {kind:'books#volumes',totalItems:3,items:['pt','en','es'].map(language=>({id:language,volumeInfo:{title:'Livro '+language,language}}))};};
  for(const[locale,code]of [['pt-BR','pt'],['en-US','en'],['es-ES','es']]){
    const result=await service.suggestions(1,undefined,'reading',locale);
    assert.equal(result.personalized,false);assert.deepEqual(result.results.map(book=>book.language),[code]);
  }
  await service.suggestions(1,undefined,'reading','pt-BR');assert.deepEqual(requests,['pt','en','es']);
});

// O contexto de leitura não consulta exemplares nem compartilha o perfil privado de outro dono.
test('sugestões de leitura usam exclusivamente o acompanhamento da sessão', async () => {
  const rows = [{ ...classic, ownerId: a, kind: 'book' }, { ...classic, ownerId: b, kind: 'book', publisher: 'Outra editora' }];
  const db = fakeConnection(rows, 'library_items');
  const service = new BooksService(db.connection);
  service.request = async () => ({ kind: 'books#volumes', totalItems: 1, items: [volume('reading', 'Outro clássico', 'Fiction / Classics', 'Rocco')] });
  const result = await service.suggestions(1, a.toString(), 'reading');
  assert.equal(result.personalized, true);
  assert.deepEqual(result.results.map(book => book.title), ['Outro clássico']);
  assert.ok(db.filters.every(filter => filter.ownerId.equals(a)));
});
