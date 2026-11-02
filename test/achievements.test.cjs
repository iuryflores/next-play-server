const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
// A suíte nunca acessa o Atlas da conta; remove somente seu banco local aleatório.
const database='nextplay_achievements_test_'+randomUUID().replaceAll('-','');
process.env.MONGODB_URI='mongodb://127.0.0.1:27017/'+database;
process.env.NODE_ENV='test';process.env.CLIENT_ORIGIN='http://localhost:5174';
process.env.ALLOW_REGISTRATION='true';process.env.EMAIL_VERIFICATION_REQUIRED='false';process.env.SWAGGER_ENABLED='true';
const {createApp}=require('../dist/bootstrap');
const {getConnectionToken}=require('@nestjs/mongoose');
const {Types}=require('mongoose');
const {dailyEpisodeRecord,seasonInOneDay,achievements}=require('../dist/achievements/achievement-rules');

test('temporada em um dia exige todos os episódios individuais no mesmo dia civil',()=>{
  const expected=['a','b'], now=new Date('2026-11-02');
  const rows=[{key:'a',watchedAt:new Date('2026-10-30T02:30Z'),watchOrigin:'individual'},{key:'b',watchedAt:new Date('2026-10-30T03:30Z'),watchOrigin:'individual'}];
  assert.equal(seasonInOneDay(rows,expected,'UTC',now),true);
  assert.equal(seasonInOneDay(rows,expected,'America/Sao_Paulo',now),false);
  assert.equal(seasonInOneDay(rows.slice(0,1),expected,'UTC',now),false);
  for(const origin of ['bulk',undefined]) assert.equal(seasonInOneDay([{...rows[0],watchOrigin:origin},rows[1]],expected,'UTC',now),false);
  assert.equal(seasonInOneDay([rows[0],rows[0]],expected,'UTC',now),false);
  assert.equal(seasonInOneDay(rows,[],'UTC',now),false);
  assert.equal(seasonInOneDay([{...rows[0],watchedAt:new Date('2099-01-01')},rows[1]],expected,'UTC',now),false);
  assert.equal(seasonInOneDay([{...rows[0],watchedAt:new Date('invalid')},rows[1]],expected,'UTC',now),false);
});

test('maratonas usam dias civis do fuso, episódios distintos e origem individual nova',()=>{
  const rows=[
    {key:'a',watchedAt:new Date('2026-10-30T02:30:00Z'),watchOrigin:'individual'},
    {key:'b',watchedAt:new Date('2026-10-30T03:30:00Z'),watchOrigin:'individual'},
    {key:'b',watchedAt:new Date('2026-10-30T03:30:00Z'),watchOrigin:'individual'},
    {key:'bulk',watchedAt:new Date('2026-10-30T03:30:00Z'),watchOrigin:'bulk'},
    {key:'legacy',watchedAt:new Date('2026-10-30T03:30:00Z')},
    {key:'future',watchedAt:new Date('2099-01-01'),watchOrigin:'individual'},
  ];
  assert.equal(dailyEpisodeRecord(rows,'UTC',new Date('2026-11-01')),2);
  assert.equal(dailyEpisodeRecord(rows,'America/Sao_Paulo',new Date('2026-11-01')),1);
  assert.equal(new Set(achievements.map(item=>item.id)).size,achievements.length);
  assert.deepEqual(achievements.filter(item=>item.family==='binge').map(item=>item.target),Array.from({length:20},(_,i)=>(i+1)*5));
});

test('conquistas privadas, persistentes, idempotentes e ligadas ao consumo/posse reais',async t=>{
  const app=await createApp();await app.listen(0,'127.0.0.1');const db=app.get(getConnectionToken()),base=await app.getUrl();
  t.after(async()=>{try{assert.match(database,/^nextplay_achievements_test_[a-f0-9]{32}$/);assert.equal(db.name,database);await db.dropDatabase();}finally{await app.close();}});
  const request=(path,method='GET',body,cookie,origin=process.env.CLIENT_ORIGIN)=>fetch(base+'/api'+path,{method,headers:{...(method!=='GET'?{origin,'Content-Type':'application/json'}:{}),...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  async function account(email){const res=await request('/auth/register','POST',{email,password:'A-long-test-password-123!'});assert.equal(res.status,201);return {user:(await res.json()).user,cookie:res.headers.get('set-cookie').split(';')[0]};}
  const a=await account('achievements-a@example.test'),b=await account('achievements-b@example.test'),ownerId=new Types.ObjectId(a.user.id);
  assert.equal((await request('/achievements')).status,401);
  assert.equal((await request('/achievements/sync','POST',{},a.cookie,'https://other.example')).status,403);
  assert.equal((await request('/achievements/sync','POST',{points:999},a.cookie)).status,400);
  assert.equal((await request('/achievements/sync','POST',{timeZone:'Invalid/Zone'},a.cookie)).status,400);
  assert.equal((await request('/achievements')).status,401);
  const initial=await (await request('/achievements','GET',undefined,a.cookie)).json();
  assert.equal(initial.achievements.filter(item=>item.unlockedAt).length,0);
  assert.equal(await db.collection('achievement_awards').countDocuments({}),0,'GET não concede conquistas');
  assert.equal((await request('/achievements/sync','POST',{},a.cookie)).status,200);
  assert.equal((await request('/achievements/title','PATCH',{},a.cookie)).status,400);
  await db.collection('library_items').insertMany([
    ...Array.from({length:10},(_,i)=>({ownerId,kind:'movie',status:'completed',title:'Filme '+i,catalogId:'tmdb:movie:'+(i+1)})),
    ...Array.from({length:5},(_,i)=>({ownerId,kind:'book',status:'completed',title:'Livro '+i})),
  ]);
  await db.collection('collector_copies').insertMany(Array.from({length:10},(_,i)=>({ownerId,title:'Exemplar '+i,kind:'book',format:'physical'})));
  const seriesId=new Types.ObjectId(),catalogId='tmdb:series:900';
  await db.collection('library_items').insertOne({_id:seriesId,ownerId,kind:'series',status:'active',title:'Série de teste',catalogId});
  const episodes=(n)=>Array.from({length:n},(_,i)=>({number:i+1,name:'Episódio '+(i+1),airDate:'2020-01-01'}));
  await db.collection('series_seasons').insertMany([
    {catalogId,number:1,total:5,loaded:true,episodes:episodes(5)},
    {catalogId,number:2,total:12,loaded:true,episodes:episodes(12)},
    {catalogId,number:3,total:10,loaded:true,episodes:episodes(10)},
    {catalogId,number:0,total:2,loaded:true,episodes:episodes(2)},
    {catalogId,number:4,total:3,loaded:true,episodes:[...episodes(2),{number:3,airDate:'2099-01-01'}]},
  ]);
  await db.collection('episode_progress').insertMany(Array.from({length:4},(_,i)=>({itemId:seriesId,season:1,episode:i+1,watchedAt:new Date()})));
  const sync=async cookie=>{const res=await request('/achievements/sync','POST',{timeZone:'America/Sao_Paulo'},cookie||a.cookie);assert.equal(res.status,200);return res.json();};
  const states=await Promise.all(Array.from({length:5},()=>sync()));
  const state=states.at(-1),earned=state.achievements.filter(item=>item.unlockedAt);
  assert.deepEqual(earned.map(item=>item.id).sort(),['cinephile-10','collector-10','first-play-1','reader-5']);
  assert.equal(await db.collection('achievement_awards').countDocuments({ownerId}),4,'sincronizações concorrentes não duplicam medalhas');
  const cinephile=state.achievements.find(item=>item.id==='cinephile-10');
  assert.equal(cinephile.level,1);assert.equal(cinephile.levels,4);
  assert.equal(state.achievements.length,54);
  await db.collection('library_items').updateMany({ownerId,kind:'movie'},{$set:{year:'1999',stars:4}});
  // Simula identidade legada equivalente; o índice atual já impede catalogId duplicado.
  await db.collection('library_items').insertOne({ownerId,kind:'movie',status:'completed',title:'Cópia do filme',catalogKey:'tmdb:movie:1',year:'1999',stars:5});
  await db.collection('library_items').insertOne({ownerId,kind:'series',status:'completed',title:'Série manual concluída'});
  const expanded=await sync();
  for(const id of ['classics-5','classics-10','critic-5','critic-10','series-finale-1'])assert.ok(expanded.achievements.find(item=>item.id===id).unlockedAt,id);
  assert.equal(expanded.achievements.find(item=>item.id==='classics-10').current,10,'cópias não duplicam filmes');
  assert.equal(expanded.achievements.find(item=>item.id==='critic-10').current,10);
  const isolated=await sync(b.cookie);assert.equal(isolated.achievements.filter(item=>item.unlockedAt).length,0);
  assert.equal((await request('/achievements/title','PATCH',{achievementId:'cinephile-10'},b.cookie)).status,400);
  assert.equal((await request('/achievements/title','PATCH',{achievementId:'cinephile-25'},a.cookie)).status,400);
  assert.equal((await request('/achievements/title','PATCH',{achievementId:'cinephile-10'},a.cookie)).status,200);
  assert.equal((await sync()).selectedId,'cinephile-10');
  assert.equal((await request('/achievements/celebrations','POST',{ids:['first-play-1']},a.cookie)).status,200);
  assert.ok(!(await sync()).pending.includes('first-play-1'));
  assert.equal((await request('/achievements/celebrations','POST',{ids:['fake-1']},a.cookie)).status,400);
  const watch=async(season,episode)=>{const res=await request(`/library/${seriesId}/episodes`,'PATCH',{season,episode,watched:true},a.cookie);assert.equal(res.status,200);};
  await watch(1,5);
  let after=await sync();assert.ok(after.achievements.find(item=>item.id==='season-1').unlockedAt);
  assert.equal(after.achievements.find(item=>item.id==='binge-5').current,1,'legado não vira uma maratona de hoje');
  const bulk=await request(`/library/${seriesId}/episodes/watch-many`,'POST',{scope:'season',season:2},a.cookie);assert.equal(bulk.status,201);
  after=await sync();assert.equal(after.achievements.find(item=>item.id==='binge-5').current,1,'temporada em lote não conta como maratona');
  assert.equal((await db.collection('episode_progress').findOne({itemId:seriesId,season:2,episode:1})).watchOrigin,'bulk');
  for(let i=1;i<=5;i++)await watch(3,i);
  await watch(3,1);await watch(1,1);
  after=await sync();assert.equal(after.achievements.find(item=>item.id==='binge-5').current,6,'remarcar não duplica nem converte o legado');
  assert.ok(after.achievements.find(item=>item.id==='binge-5').unlockedAt);
  assert.equal(after.achievements.find(item=>item.id==='binge-10').unlockedAt,null);
  for(let i=6;i<=10;i++)await watch(3,i);
  after=await sync();assert.ok(after.achievements.find(item=>item.id==='binge-10').unlockedAt);
  assert.ok(after.achievements.find(item=>item.id==='day-season-1').unlockedAt,'temporada 3 foi vista individualmente no mesmo dia');
  assert.ok(after.achievements.find(item=>item.id==='episode-voyager-25').unlockedAt,'episódios acumulados incluem lotes e legado');
  // A rota /complete recupera episódios de séries legadas já marcadas como concluídas.
  await db.collection('library_items').updateOne({_id:seriesId},{$set:{status:'completed',completedAt:new Date()},$unset:{episodesCompletedAt:''}});
  const complete=await request(`/library/${seriesId}/episodes/complete`,'POST',{},a.cookie);
  assert.equal(complete.status,201);
  assert.equal((await db.collection('episode_progress').findOne({itemId:seriesId,season:4,episode:1})).watchOrigin,'bulk');
  after=await sync();assert.equal(after.achievements.find(item=>item.id==='binge-10').current,11,'conclusão integral não inventa maratona');
  assert.equal(after.achievements.find(item=>item.id==='season-1').current,3,'temporada com episódio futuro não é encerrada');
  await db.collection('library_items').deleteMany({ownerId,kind:{$in:['movie','book']}});
  await db.collection('collector_copies').deleteMany({ownerId});
  after=await sync();assert.equal(after.achievements.find(item=>item.id==='cinephile-10').current,0);assert.ok(after.achievements.find(item=>item.id==='cinephile-10').unlockedAt);assert.equal(after.selectedId,'cinephile-10');
  assert.equal((await request('/achievements/title','PATCH',{achievementId:null},a.cookie)).status,200);
  assert.equal((await sync()).selectedId,null);
  const spec=await (await request('/docs-json')).json();
  for(const path of ['/api/achievements','/api/achievements/sync','/api/achievements/title','/api/achievements/celebrations'])assert.ok(spec.paths[path]);
  assert.equal(spec.components.schemas.TitleDto.properties.achievementId.nullable,true);
  assert.equal(spec.components.schemas.AchievementViewDto.properties.unlockedAt.nullable,true);
  assert.equal(spec.components.schemas.AchievementViewDto.properties.current.minimum,0);
  assert.equal(spec.components.schemas.AchievementViewDto.properties.level.minimum,1);
  assert.ok(spec.components.schemas.AchievementViewDto.properties.metric.enum.includes('daySeason'));
});
