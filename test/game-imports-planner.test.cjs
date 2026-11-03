const {test}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
require('reflect-metadata');const database='np_game_import_'+randomUUID().replaceAll('-','');
process.env.MONGODB_URI='mongodb://127.0.0.1:27017/'+database;process.env.NODE_ENV='test';process.env.CLIENT_ORIGIN='http://localhost:5174';process.env.ALLOW_REGISTRATION='true';process.env.EMAIL_VERIFICATION_REQUIRED='false';
const {createApp}=require('../dist/bootstrap');const {getConnectionToken}=require('@nestjs/mongoose');const {Types}=require('mongoose');const {GameImportsService}=require('../dist/game-imports/game-imports.module');const {CatalogService}=require('../dist/catalog/catalog.module');
test('importação privada separa posse e consumo, não duplica horas e preserva sessões/avaliações',async t=>{
 const app=await createApp();await app.listen(0,'127.0.0.1');const base=await app.getUrl(),db=app.get(getConnectionToken());t.after(async()=>{try{assert.equal(db.name,database);assert.match(database,/^np_game_import_[a-f0-9]{32}$/);await db.dropDatabase();}finally{await app.close();}});
 async function call(path,method='GET',user,body,origin=process.env.CLIENT_ORIGIN){return fetch(base+'/api/'+path,{method,headers:{...(user?{cookie:user.cookie}:{}),origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}
 async function json(path,user){const r=await call(path,'GET',user);assert.equal(r.status,200,await r.clone().text());return r.json();}
 async function register(name){const r=await call('auth/register','POST',null,{email:name+'@example.test',password:'Long-test-password-123!'});assert.equal(r.status,201);return{id:(await r.json()).user.id,cookie:r.headers.get('set-cookie').split(';')[0]};}
 const a=await register('one'),b=await register('two'),ownerId=new Types.ObjectId(a.id);
 assert.equal((await call('game-imports')).status,401);
 const service=app.get(GameImportsService);const oldKey=process.env.STEAM_WEB_API_KEY;delete process.env.STEAM_WEB_API_KEY;t.after(()=>{if(oldKey===undefined)delete process.env.STEAM_WEB_API_KEY;else process.env.STEAM_WEB_API_KEY=oldKey;});
 assert.equal((await json('game-imports',a)).steamConfigured,false);
 assert.equal((await call('game-imports/steam','POST',a,{steamId:'76561198000000000'})).status,503);
 assert.equal((await call('game-imports/steam','POST',a,{steamId:'https://bad.test'})).status,400);
 const file={provider:'xbox',games:[{externalId:'game-1',title:'Jogo importado',playtimeMinutes:290,achievementsUnlocked:5,achievementsTotal:20}]};
 assert.equal((await call('game-imports/file','POST',a,file,'https://evil.test')).status,403);
 assert.equal((await call('game-imports/file','POST',a,{...file,games:[...file.games,...file.games]})).status,400);
 assert.equal((await call('game-imports/file','POST',a,{...file,games:[{...file.games[0],achievementsUnlocked:21}]})).status,400);
 const response=await call('game-imports/file','POST',a,file);assert.equal(response.status,201);const preview=await response.json();
 assert.equal(await db.collection('library_items').countDocuments(),0);assert.equal(await db.collection('collector_copies').countDocuments(),0);
 assert.equal((await call('game-imports/preview/'+preview.id,'GET',b)).status,404);
 const path='game-imports/preview/'+preview.id+'/game-1/apply';
 assert.equal((await call(path,'POST',b,{collection:true,tracking:false})).status,404);
 for(let i=0;i<2;i++)assert.equal((await call(path,'POST',a,{collection:true,tracking:false})).status,201);
 assert.equal(await db.collection('collector_copies').countDocuments({ownerId}),1);assert.equal(await db.collection('library_items').countDocuments({ownerId}),0);
 const result=await call(path,'POST',a,{collection:false,tracking:true});assert.equal(result.status,201);const id=(await result.json()).itemId;
 assert.equal((await call(path,'POST',a,{collection:true,tracking:true})).status,201);
 let tracked=await db.collection('library_items').findOne({_id:new Types.ObjectId(id)});assert.equal(tracked.playtimeMinutes,290);assert.equal(tracked.status,'planned');assert.equal(tracked.completedOn,undefined);assert.equal(tracked.gameSessions,undefined);assert.equal(await db.collection('social_activities').countDocuments(),0);
 const stats=await json('game-imports/stats/'+id,a);assert.equal(stats.sources[0].achievementsUnlocked,5);assert.equal((await call('game-imports/stats/'+id,'GET',b)).status,404);
 // Um destino existente conserva o que foi registrado no NextPlay; totais importados não são sessões extras.
 const own=new Types.ObjectId(),other=new Types.ObjectId();await db.collection('library_items').insertMany([{_id:own,ownerId,title:'Já acompanho',kind:'game',status:'completed',notes:'Manter',stars:5,platform:'PC',playtimeMinutes:500,gameSessions:[{id:'sessao',playedOn:'2026-01-01',minutes:50}]},{_id:other,ownerId:new Types.ObjectId(b.id),title:'Alheio',kind:'game',status:'active',playtimeMinutes:20}]);
 const file2={provider:'gog',games:[{externalId:'gog1',title:'Já acompanho',playtimeMinutes:300}]};const p2=await(await call('game-imports/file','POST',a,file2)).json(),path2='game-imports/preview/'+p2.id+'/gog1/apply';
 assert.equal((await call(path2,'POST',a,{collection:false,tracking:true,itemId:other.toString()})).status,404);
 for(let i=0;i<2;i++)assert.equal((await call(path2,'POST',a,{collection:false,tracking:true,itemId:own.toString()})).status,201);
 tracked=await db.collection('library_items').findOne({_id:own});assert.equal(tracked.playtimeMinutes,500);assert.equal(tracked.status,'completed');assert.equal(tracked.stars,5);assert.equal(tracked.notes,'Manter');assert.equal(tracked.gameSessions.length,1);
 assert.equal((await call(path2,'POST',a,{collection:false,tracking:true,itemId:id})).status,409);
 // Importações concorrentes da mesma origem mantêm uma entrada e o maior total.
 const previews=[];for(const minutes of [200,400])previews.push(await(await call('game-imports/file','POST',a,{provider:'epic',games:[{externalId:'epic1',title:'Concorrente',playtimeMinutes:minutes}]})).json());
 const concurrent=await Promise.all(previews.map(p=>call('game-imports/preview/'+p.id+'/epic1/apply','POST',a,{collection:true,tracking:true})));
 assert.deepEqual(concurrent.map(r=>r.status),[201,201]);
 const concurrentItems=await db.collection('library_items').find({ownerId,catalogKey:'external:epic:epic1'}).toArray();assert.equal(concurrentItems.length,1);assert.equal(concurrentItems[0].playtimeMinutes,400);
 // O provedor é simulado: nenhum perfil Steam real ou serviço externo é consultado.
 service.steam=async(path,params)=>path.includes('OwnedGames')?{response:{game_count:1,games:[{appid:42,name:'Steam teste',playtime_forever:90}]}}:{playerstats:{success:true,achievements:[{achieved:1},{achieved:0}]}};
 const sp=await(await call('game-imports/steam','POST',a,{steamId:'76561198000000000'})).json();assert.equal(sp.games[0].playtimeMinutes,90);
 const ach=await call('game-imports/preview/'+sp.id+'/42/achievements','POST',a,{});assert.equal(ach.status,201);assert.deepEqual(await ach.json(),{achievementsTotal:2,achievementsUnlocked:1});
 // A conta de origem é a da prévia importada, nunca inferida da conexão atual.
 const steamApply=await call('game-imports/preview/'+sp.id+'/42/apply','POST',a,{collection:false,tracking:true});assert.equal(steamApply.status,201);const steamItemId=(await steamApply.json()).itemId;
 let steamStats=await json('game-imports/stats/'+steamItemId,a);assert.equal(steamStats.sources[0].gameUrl,'https://store.steampowered.com/app/42');assert.equal(steamStats.sources[0].accountUrl,'https://steamcommunity.com/profiles/76561198000000000');assert.equal(steamStats.sources[0].playtimeMinutes,90);
 await db.collection('steam_connections').updateOne({_id:ownerId},{$set:{steamId:'76561198000000099'}},{upsert:true});
 assert.equal((await json('game-imports/stats/'+steamItemId,a)).sources[0].steamAccountId,'76561198000000000');
 assert.equal((await json('library',a)).items.find(item=>item.id===steamItemId).steamImportAppId,'42');
 // Legados ganham o selo por leitura em lote, mas a conta ausente não é inventada nem migrada no GET.
 await db.collection('library_items').updateOne({_id:new Types.ObjectId(steamItemId)},{$unset:{steamImportAppId:''}});
 await db.collection('external_game_data').updateOne({ownerId,itemId:new Types.ObjectId(steamItemId)},{$unset:{steamAccountId:''}});
 assert.equal((await json('library',a)).items.find(item=>item.id===steamItemId).steamImportAppId,'42');
 steamStats=await json('game-imports/stats/'+steamItemId,a);assert.equal(steamStats.sources[0].accountUrl,null);
 assert.equal((await db.collection('library_items').findOne({_id:new Types.ObjectId(steamItemId)})).steamImportAppId,undefined);
 service.steam=async()=>({response:{}});assert.equal((await call('game-imports/steam','POST',a,{steamId:'76561198000000000'})).status,502);
 await db.collection('game_import_previews').updateOne({_id:preview.id},{$set:{expiresAt:new Date(0)}});assert.equal((await call('game-imports/preview/'+preview.id,'GET',a)).status,404);
});
test('planejador pagina apenas jogos próprios pendentes, separa falhas e não altera biblioteca',async t=>{
 const app=await createApp();await app.listen(0,'127.0.0.1');const base=await app.getUrl(),db=app.get(getConnectionToken());t.after(async()=>{try{assert.equal(db.name,database);await db.dropDatabase();}finally{await app.close();}});
 const reg=await fetch(base+'/api/auth/register',{method:'POST',headers:{origin:process.env.CLIENT_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({email:'planner@example.test',password:'Long-test-password-123!'})});const ownerId=new Types.ObjectId((await reg.json()).user.id),cookie=reg.headers.get('set-cookie').split(';')[0];
 const rows=Array.from({length:23},(_,i)=>({ownerId,title:'Game '+i,kind:'game',status:'planned',playtimeMinutes:10,catalogId:'igdb:game:'+(i+1)}));await db.collection('library_items').insertMany([...rows,{ownerId,title:'Fim',kind:'game',status:'completed'},{ownerId,title:'Arquivo',kind:'game',status:'planned',archived:true},{ownerId:new Types.ObjectId(),title:'Alheio',kind:'game',status:'planned'}]);
 const catalog=app.get(CatalogService);catalog.gameEstimate=async id=>{if(id==='igdb:game:1')throw Error('offline');return{supported:true,source:'igdb',mainMinutes:60,extrasMinutes:null,completionistMinutes:null,sampleCount:1};};
 assert.equal((await fetch(base+'/api/game-planner')).status,401);assert.equal((await fetch(base+'/api/game-planner?after=bad',{headers:{cookie}})).status,400);
 const first=await(await fetch(base+'/api/game-planner',{headers:{cookie}})).json();assert.equal(first.total,23);assert.equal(first.items.length,20);assert.equal(first.items.filter(i=>i.estimateFailed).length,1);assert.equal(first.items[0].ownerId,undefined);
 const second=await(await fetch(base+'/api/game-planner?after='+first.nextAfter,{headers:{cookie}})).json();assert.equal(second.items.length,3);assert.equal(second.nextAfter,null);assert.equal(new Set([...first.items,...second.items].map(i=>i.id)).size,23);
 assert.equal(await db.collection('library_items').countDocuments({ownerId,status:'planned'}),24);
});
