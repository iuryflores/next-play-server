const {test}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
require('reflect-metadata');const database='np_steam_login_'+randomUUID().replaceAll('-','');
process.env.MONGODB_URI='mongodb://127.0.0.1:27017/'+database;process.env.NODE_ENV='test';process.env.CLIENT_ORIGIN='http://localhost:5174';process.env.ALLOW_REGISTRATION='true';process.env.EMAIL_VERIFICATION_REQUIRED='false';
const {SteamConnectionService}=require('../dist/game-imports/steam-connection');
const {GameImportsService}=require('../dist/game-imports/game-imports.module');
const {getConnectionToken}=require('@nestjs/mongoose');const {Types}=require('mongoose');
const endpoint='https://steamcommunity.com/openid/login',ns='http://specs.openid.net/auth/2.0';
test('verificação direta usa host fixo, POST e assinatura confirmada, sem chave ou senha no corpo',async t=>{
 const service=new SteamConnectionService(null);let result='ns:'+ns+'\nis_valid:true\n';
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,endpoint);assert.equal(options.method,'POST');assert.equal(options.redirect,'error');const body=new URLSearchParams(options.body);assert.equal(body.get('openid.mode'),'check_authentication');assert.equal(body.get('openid.sig'),'signed');assert.equal(body.has('key'),false);assert.equal(body.has('state'),false);return new Response(result);});
 const params=new URLSearchParams({'openid.mode':'id_res','openid.sig':'signed',state:'not forwarded'});
 assert.equal(await service.verify(params),true);result='ns:'+ns+'\nis_valid:false\n';assert.equal(await service.verify(params),false);result='is_valid:true\n';assert.equal(await service.verify(params),false);
});
test('login Steam vincula sessão e retorno, rejeita adulteração/replay e desconecta sem apagar jogos',async t=>{
 const {createApp}=require('../dist/bootstrap');const app=await createApp();await app.listen(0,'127.0.0.1');const base=await app.getUrl(),db=app.get(getConnectionToken());t.after(async()=>{try{assert.equal(db.name,database);assert.match(database,/^np_steam_login_[a-f0-9]{32}$/);await db.dropDatabase();}finally{await app.close();}});
 async function call(path,method='GET',user,body,origin=process.env.CLIENT_ORIGIN){return fetch(base+'/api/game-imports'+path,{method,redirect:'manual',headers:{...(user?{cookie:user.cookie}:{}),origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}
 async function register(name){const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{origin:process.env.CLIENT_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({email:name+'@example.test',password:'Long-test-password-123!'})});assert.equal(r.status,201);return{id:(await r.json()).user.id,cookie:r.headers.get('set-cookie').split(';')[0]};}
 const a=await register('steam-a'),b=await register('steam-b'),service=app.get(SteamConnectionService);let verifications=0;service.verify=async()=>{verifications++;return true;};
 const status=async user=>(await(await call('','GET',user)).json()).steamConnection;
 async function begin(){const r=await call('/steam/connect','POST',a,{});assert.equal(r.status,201);const url=new URL((await r.json()).url);assert.equal(url.origin+url.pathname,endpoint);assert.equal(url.searchParams.get('openid.realm'),process.env.CLIENT_ORIGIN+'/');const rt=new URL(url.searchParams.get('openid.return_to'));assert.equal(rt.origin,process.env.CLIENT_ORIGIN);assert.match(rt.searchParams.get('state'),/^[a-f0-9]{64}$/);return rt;}
 function assertion(rt,changes={}){const params=new URLSearchParams(rt.search);for(const [key,value] of Object.entries({'openid.ns':ns,'openid.mode':'id_res','openid.op_endpoint':endpoint,'openid.claimed_id':'https://steamcommunity.com/openid/id/76561198000000000','openid.identity':'https://steamcommunity.com/openid/id/76561198000000000','openid.return_to':rt.href,'openid.response_nonce':new Date().toISOString().slice(0,19)+'Z'+randomUUID(),'openid.assoc_handle':'handle','openid.signed':'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle','openid.sig':'signed',...changes}))params.set(key,value);return '/steam/callback?'+params;}
 assert.equal((await call('/steam/connect','POST',null,{})).status,401);assert.equal((await call('/steam/connect','POST',a,{},'https://evil.test')).status,403);assert.equal((await call('/steam/library','POST',a,{})).status,400);
 const rt=await begin(),callback=assertion(rt);
 assert.equal((await call(callback,'GET',b)).status,303);assert.equal((await status(b)).connected,false);assert.equal(verifications,0);
 // Outra sessão da mesma conta tampouco pode concluir a tentativa original.
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{origin:process.env.CLIENT_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({email:'steam-a@example.test',password:'Long-test-password-123!'})});assert.equal(login.status,200);const second={...a,cookie:login.headers.get('set-cookie').split(';')[0]};
 await call(callback,'GET',second);assert.equal(verifications,0);
 const connected=await call(callback,'GET',a);assert.equal(connected.status,303);assert.equal(connected.headers.get('location'),process.env.CLIENT_ORIGIN+'/conta');assert.equal((await status(a)).connected,true);assert.equal(verifications,1);
 await call(callback,'GET',a);assert.equal(verifications,1);
 const imports=app.get(GameImportsService);imports.fromSteam=async(owner,id)=>{assert.equal(owner,a.id);assert.equal(id,'76561198000000000');return{id:randomUUID(),games:[],total:0,nextOffset:null};};
 assert.equal((await call('/steam/library','POST',a,{steamId:'76561198000000099'})).status,201);
 const originalId=(await status(a)).steamId;
 for(const change of [{'openid.op_endpoint':'https://evil.test/'},{'openid.return_to':'https://evil.test/'},{'openid.identity':'https://steamcommunity.com/openid/id/76561198000000099'},{'openid.signed':'op_endpoint,identity'},{'openid.response_nonce':'2000-01-01T00:00:00Zold'}]){
   const before=verifications;await call(assertion(await begin(),change),'GET',a);assert.equal(verifications,before);assert.equal((await status(a)).steamId,originalId);
 }
 service.verify=async()=>false;await call(assertion(await begin()),'GET',a);assert.equal((await status(a)).steamId,originalId);assert.equal((await status(a)).lastResult,'error');
 service.verify=async()=>true;const cancel=await begin();cancel.searchParams.set('openid.mode','cancel');await call('/steam/callback?'+cancel.searchParams,'GET',a);assert.equal((await status(a)).lastResult,'cancelled');assert.equal((await status(a)).steamId,originalId);
 const expired=await begin();await db.collection('steam_login_states').updateMany({ownerId:new Types.ObjectId(a.id)},{$set:{expiresAt:new Date(0)}});await call(assertion(expired),'GET',a);assert.equal((await status(a)).steamId,originalId);
 // A desconexão invalida inclusive um callback que está no meio da verificação externa.
 const itemId=new Types.ObjectId();await db.collection('library_items').insertOne({_id:itemId,ownerId:new Types.ObjectId(a.id),kind:'game',title:'Manter importado'});
 let entered,release;const started=new Promise(resolve=>entered=resolve),finish=new Promise(resolve=>release=resolve);service.verify=async()=>{entered();await finish;return true;};
 const pendingCallback=call(assertion(await begin()),'GET',a);await started;
 assert.equal((await call('/steam/connection','DELETE',a)).status,200);release();await pendingCallback;
 assert.equal((await status(a)).connected,false);assert.equal(await db.collection('library_items').countDocuments({_id:itemId}),1);assert.equal((await call('/steam/library','POST',a,{})).status,400);
});

