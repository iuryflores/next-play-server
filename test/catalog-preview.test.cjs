// As prévias não devem criar registros privados; o cadastro concluído ocorre só na confirmação.
process.env.NODE_ENV = 'test';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
process.env.ALLOW_REGISTRATION = 'true';
process.env.SWAGGER_ENABLED = 'true';
process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.TMDB_API_ACCESS_TOKEN = 'test-provider-token';
const {randomUUID}=require('node:crypto');
const database='nextplay_preview_test_'+randomUUID().replaceAll('-','');
process.env.MONGODB_URI='mongodb://127.0.0.1:27017/'+database;
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createApp}=require('../dist/bootstrap');
const {getConnectionToken}=require('@nestjs/mongoose');

test('detalhes e trailers autenticados precedem cadastro direto como assistido sem itens provisórios',async t=>{
 const realFetch=global.fetch;let externalCalls=0;let videosFail=false;const languages=[];
 global.fetch=async(input,options)=>{
  const url=new URL(String(input));
  if(url.hostname!=='api.themoviedb.org')return realFetch(input,options);
  externalCalls++;
  if(url.pathname.endsWith('/credits'))return Response.json({cast:[{id:42,name:'Ator de teste',character:'Herói',profile_path:'/actor.jpg'}]});
  if(url.pathname.endsWith('/videos')){
   if(videosFail)return Response.json({},{status:503});
   languages.push(url.searchParams.get('language'));
   return Response.json({results:url.searchParams.get('language')==='pt-BR'?[]:[{key:'abcdefghijk',name:'Official trailer',site:'YouTube',type:'Trailer',official:true}]});
  }
  const id=Number(url.pathname.split('/').at(-1));
  return Response.json({id,title:'Filme completo',original_title:'Original movie',runtime:123,overview:'Sinopse completa do catálogo.',release_date:'2020-01-01',genres:[{id:18,name:'Drama'}],production_companies:[{id:1,name:'Produtora de teste'}]});
 };
 const app=await createApp();await app.listen(0,'127.0.0.1');const base=await app.getUrl(),db=app.get(getConnectionToken());
 t.after(async()=>{global.fetch=realFetch;try{assert.equal(db.name,database);assert.match(database,/^nextplay_preview_test_[a-f0-9]{32}$/);await db.dropDatabase();}finally{await app.close();}});
 const call=(path,cookie,body)=>realFetch(base+'/api'+path,{method:body?'POST':'GET',headers:{origin:process.env.CLIENT_ORIGIN,...(cookie?{cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 for(const path of ['details','trailer','cast'])assert.equal((await call('/catalog/'+path+'?catalogId=tmdb:movie:11')).status,401);
 assert.equal(externalCalls,0);
 const register=await call('/auth/register',null,{email:'preview@example.test',password:'Long-test-password-123!'});assert.equal(register.status,201);const cookie=register.headers.get('set-cookie').split(';')[0];
 for(const reference of ['https://example.com','local:private','googlebooks:book:test','tmdb:movie:0'])assert.equal((await call('/catalog/details?catalogId='+encodeURIComponent(reference),cookie)).status,400);
 assert.equal((await call('/catalog/details?catalogId=tmdb:movie:11&ownerId=forged',cookie)).status,400);
 assert.equal((await call('/catalog/cast?catalogId=local:private',cookie)).status,400);
 assert.equal((await call('/catalog/cast?catalogId=tmdb:movie:11&ownerId=forged',cookie)).status,400);
 const details=await call('/catalog/details?catalogId=tmdb:movie:11',cookie);assert.equal(details.status,200);const title=(await details.json()).title;
 assert.equal(title.runtime,123);assert.equal(title.overview,'Sinopse completa do catálogo.');assert.deepEqual(title.productionCompanies.map(c=>c.name),['Produtora de teste']);
 const trailer=await call('/catalog/trailer?catalogId=tmdb:movie:11',cookie);assert.equal(trailer.status,200);assert.equal((await trailer.json()).trailer.key,'abcdefghijk');assert.deepEqual(languages,['pt-BR','en-US']);
 const cast=await call('/catalog/cast?catalogId=tmdb:movie:11',cookie);assert.equal(cast.status,200);const people=await cast.json();
 assert.equal(people.supported,true);assert.equal(people.cast[0].actor,'Ator de teste');assert.equal(people.cast[0].character,'Herói');
 const beforeCastCache=externalCalls;await call('/catalog/cast?catalogId=tmdb:movie:11',cookie);assert.equal(externalCalls,beforeCastCache);
 assert.equal(await db.collection('library_items').countDocuments(),0);assert.equal(await db.collection('collector_copies').countDocuments(),0);assert.equal(await db.collection('catalog_titles').countDocuments(),0);
 const schema=await(await call('/docs-json')).json();
 for(const path of ['details','trailer','cast']){const route=schema.paths['/api/catalog/'+path].get;assert.deepEqual(route.security,[{session:[]}]);assert.ok(route.responses['401']);assert.ok(route.responses['429']);}
 videosFail=true;
 assert.equal((await call('/catalog/trailer?catalogId=tmdb:movie:12',cookie)).status,502);
 assert.equal((await call('/catalog/details?catalogId=tmdb:movie:12',cookie)).status,200);
 const body={title:'Nome forjado',kind:'movie',catalogId:title.catalogId,status:'completed',completedOn:'2020-02-03',stars:4,feeling:'liked',favoriteCharacter:people.cast[0].character,favoriteCastId:people.cast[0].id};
 const saved=await call('/library',cookie,body);assert.equal(saved.status,201);const item=(await saved.json()).item;
 assert.equal(item.title,title.title);assert.equal(item.status,'completed');assert.equal(item.completedOn,'2020-02-03');assert.equal(item.stars,4);assert.equal(item.feeling,'liked');
 assert.equal(item.favoriteCharacter,'Herói');assert.equal(item.favoriteCastId,'42:Herói');
 const persisted=await db.collection('library_items').findOne({_id:new (require('mongoose').Types.ObjectId)(item.id)});
 assert.equal(persisted.favoriteActorId,'42');assert.equal(persisted.favoriteActorName,'Ator de teste');
 assert.equal((await call('/library',cookie,body)).status,409);assert.equal(await db.collection('library_items').countDocuments(),1);assert.equal(await db.collection('collector_copies').countDocuments(),0);
});
