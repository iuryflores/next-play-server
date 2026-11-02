// Exercita o idioma persistido da conta com banco descartável, sem acessar contas reais.
process.env.NODE_ENV='test';process.env.EMAIL_VERIFICATION_REQUIRED='false';process.env.ALLOW_REGISTRATION='true';process.env.SWAGGER_ENABLED='true';process.env.CLIENT_ORIGIN='http://localhost:5174';
const{randomUUID}=require('node:crypto');const database='nextplay_book_language_test_'+randomUUID().replaceAll('-','');process.env.MONGODB_URI='mongodb://127.0.0.1:27017/'+database;
const{test}=require('node:test'),assert=require('node:assert/strict');const{Types}=require('mongoose');
const{createApp}=require('../dist/bootstrap'),{getConnectionToken}=require('@nestjs/mongoose');const{BooksService}=require('../dist/books/books.module');

test('coleção e Explorar leem idioma do perfil da sessão e não do exemplar inglês',async t=>{
  const app=await createApp();await app.listen(0,'127.0.0.1');const base=await app.getUrl(),db=app.get(getConnectionToken());
  t.after(async()=>{try{assert.equal(db.name,database);assert.match(database,/^nextplay_book_language_test_[a-f0-9]{32}$/);await db.dropDatabase();}finally{await app.close();}});
  const request=(path,cookie,body)=>fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{origin:process.env.CLIENT_ORIGIN,...(cookie?{cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const registration=await request('/auth/register',undefined,{email:'book-locale@example.test',password:'Language-test-password-123!'});assert.equal(registration.status,201);const cookie=registration.headers.get('set-cookie').split(';')[0],user=(await registration.json()).user;
  const seed={ownerId:new Types.ObjectId(user.id),kind:'book',title:'Owned English Book',authors:['Autora de teste'],language:'en',bookMetadataVersion:1};
  await db.collection('collector_copies').insertOne({...seed});await db.collection('library_items').insertOne({...seed,status:'planned'});
  const queries=[];const books=app.get(BooksService);
  books.request=async(_path,params)=>{queries.push(params.langRestrict);return {kind:'books#volumes',totalItems:3,items:[['pt','Livro português'],['en','English book'],['es','Libro español']].map(([language,title])=>({id:'test_'+language,volumeInfo:{title,authors:['Autora de teste'],language}}))};};
  for(const[locale,language]of [['pt-BR','pt'],['en-US','en'],['es-ES','es']]){
    const response=await request('/auth/preferences',cookie,{language:locale});assert.equal(response.status,200);
    for(const context of ['collection','reading']){
      const result=await request('/catalog/books/suggestions?context='+context,cookie);assert.equal(result.status,200);
      const data=await result.json();assert.equal(data.personalized,true);assert.deepEqual(data.results.map(book=>book.language),[language]);
    }
    const explore=await request('/library/explore?kind=book',cookie);assert.equal(explore.status,200);
    assert.deepEqual((await explore.json()).sections[0].results.map(book=>book.language),[language]);
  }
  assert.deepEqual([...new Set(queries)].sort(),['en','es','pt']);
  const spec=await(await request('/docs-json')).json();assert.match(spec.paths['/api/catalog/books/suggestions'].get.description,/idioma salvo na conta/);assert.match(spec.paths['/api/library/explore'].get.description,/idioma do perfil/);
  assert.equal((await db.collection('collector_copies').findOne()).language,'en');assert.equal((await db.collection('library_items').findOne()).language,'en');
});
