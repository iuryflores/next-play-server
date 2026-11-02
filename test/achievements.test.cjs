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
const {dailyEpisodeRecord,seasonInOneDay,achievements,reviewMilestones}=require('../dist/achievements/achievement-rules');
const {continuousLevel}=require('../dist/achievements/achievement-rules');
const {achievementProgress,gameMilestones}=require('../dist/achievements/achievement-rules');

test('maratona diária tem cinco metas finitas e nunca exige 500 episódios',()=>{
  const targets=[2,3,5,8,10];
  assert.deepEqual(achievementProgress('binge',targets,3),{progressionMode:'finite',progressionLevel:0,cycleStars:2,nextLevelTarget:5});
  assert.deepEqual(achievementProgress('binge',targets,100),{progressionMode:'finite',progressionLevel:0,cycleStars:5,nextLevelTarget:10});
  assert.equal(achievementProgress('game-platforms',[2,3,5],9).nextLevelTarget,5);
});

test('jogos contam conclusões distintas, minutos acumulados e plataformas realmente usadas',()=>{
  const rows=[
    {kind:'game',status:'completed',title:'A',catalogId:'igdb:game:1',platform:' PC ',playtimeMinutes:599},
    {kind:'game',status:'completed',title:'A duplicado',catalogId:'igdb:game:1',platform:'pc',playtimeMinutes:300},
    {kind:'game',status:'active',title:'B',platform:'PS5',playtimeMinutes:1},
    {kind:'game',status:'planned',title:'C',platform:'Switch'},
    {kind:'movie',status:'completed',title:'Filme',platform:'Xbox',playtimeMinutes:600},
  ];
  const result=gameMilestones(rows);
  assert.deepEqual(result.counts,{games:1,gameHours:10,gamePlatforms:2});
  assert.ok(result.evidence.gameHours.some(value=>value.includes('9h59min')));
  assert.deepEqual(gameMilestones([]).counts,{games:0,gameHours:0,gamePlatforms:0});
});

test('cada ciclo de cinco estrelas soma um nível e conquistas únicas não têm níveis',()=>{
  const targets=[5,10,25,50];
  for(const [count,level,stars,next] of [[0,0,0,250],[5,0,0.1,250],[50,0,1,250],[100,0,2,250],[250,1,5,500],[275,1,0.5,500],[500,2,5,750],[50000,200,5,50250]]) {
    const result=continuousLevel(targets,count);
    assert.equal(result.progressionLevel,level);
    assert.ok(Math.abs(result.cycleStars-stars)<0.00001);
    assert.equal(result.nextLevelTarget,next);
  }
  assert.deepEqual(continuousLevel([1],100),{progressionLevel:0,cycleStars:0,nextLevelTarget:1});
  assert.deepEqual(continuousLevel([10,25,50,100],338),{progressionLevel:0,cycleStars:3.38,nextLevelTarget:500});
});

test('todas as famílias progressivas seguem o mesmo ciclo de cinco estrelas',()=>{
  const families=[...new Set(achievements.map(item=>item.family))];
  for(const family of families) {
    const targets=achievements.filter(item=>item.family===family && !item.legacy).map(item=>item.target);
    const unit=targets.at(-1);
    if(targets.length===1) {
      assert.deepEqual(continuousLevel(targets,unit*20),{progressionLevel:0,cycleStars:0,nextLevelTarget:unit},family);
      continue;
    }
    // A mesma unidade vale uma estrela tanto no primeiro ciclo quanto nos próximos.
    assert.deepEqual(continuousLevel(targets,unit),{progressionLevel:0,cycleStars:1,nextLevelTarget:unit*5},family);
    assert.deepEqual(continuousLevel(targets,unit*3),{progressionLevel:0,cycleStars:3,nextLevelTarget:unit*5},family);
    assert.deepEqual(continuousLevel(targets,unit*5),{progressionLevel:1,cycleStars:5,nextLevelTarget:unit*10},family);
    assert.deepEqual(continuousLevel(targets,unit*6),{progressionLevel:1,cycleStars:1,nextLevelTarget:unit*10},family);
    assert.deepEqual(continuousLevel(targets,unit*10),{progressionLevel:2,cycleStars:5,nextLevelTarget:unit*15},family);
  }
});

test('sentimentos e favoritos contam avaliações distintas, identidade de ator e personagem por obra',()=>{
  const rows=Array.from({length:5},(_,i)=>({key:'episode:'+i,scope:'series:a',label:'Série A E'+i,feeling:'loved',favoriteActorId:'tmdb:1',favoriteActorName:'Ator A',favoriteCharacter:i%2?'  Herói  ':'HERÓI'}));
  const result=reviewMilestones([...rows,rows[0],{key:'other',scope:'series:b',label:'Série B',feeling:'liked',favoriteActorId:'tmdb:2',favoriteActorName:'Ator A',favoriteCharacter:'Herói'}]);
  assert.equal(result.loved.length,5);
  assert.equal(result.favoriteActor.length,5);
  assert.equal(result.favoriteCharacter.length,5);
  assert.ok(result.favoriteActor.every(value=>value.startsWith('Ator A — Série A')));
  assert.deepEqual(reviewMilestones([{key:'free',scope:'a',label:'A',favoriteActorName:'Ator A'}]).favoriteActor,[]);
  assert.deepEqual(reviewMilestones([]),{loved:[],favoriteActor:[],favoriteCharacter:[]});
  for(const metric of ['loved','favoriteActor','favoriteCharacter']) assert.deepEqual(achievements.filter(item=>item.metric===metric).map(item=>item.target),[3,5,10,25,50]);
});

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
  assert.deepEqual(achievements.filter(item=>item.family==='binge' && !item.legacy).map(item=>item.target),[2,3,5,8,10]);
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
  assert.deepEqual(cinephile.evidence,Array.from({length:10},(_,i)=>'Filme '+i));
  assert.equal(state.achievements.find(item=>item.id==='cinephile-25').evidence,null);
  assert.equal(cinephile.level,1);assert.equal(cinephile.levels,4);
  assert.equal(state.achievements.length,68);
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
  assert.ok(after.achievements.find(item=>item.id==='binge-10').evidence.some(value=>value.startsWith('Série de teste — T3 E10 — ')));
  assert.ok(after.achievements.find(item=>item.id==='day-season-1').unlockedAt,'temporada 3 foi vista individualmente no mesmo dia');
  assert.deepEqual(after.achievements.find(item=>item.id==='day-season-1').evidence,['Série de teste — T3']);
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
  assert.deepEqual(after.achievements.find(item=>item.id==='cinephile-10').evidence,cinephile.evidence,'evidência original permanece após edição e exclusão');
  assert.equal((await request('/achievements/title','PATCH',{achievementId:null},a.cookie)).status,200);
  assert.equal((await sync()).selectedId,null);
  // Um registro antigo sem evidência continua sem origem presumida na sincronização.
  await db.collection('achievement_awards').updateOne({ownerId,key:'first-play-1'},{$unset:{evidence:''}});
  assert.equal((await sync()).achievements.find(item=>item.id==='first-play-1').evidence,null);
  await db.collection('episode_progress').updateMany({itemId:seriesId,season:3,episode:{$lte:3}},{$set:{feeling:'loved',favoriteActorId:'tmdb:123',favoriteActorName:'Ator favorito',favoriteCharacter:'Herói'}});
  const favorites=await sync();
  for(const id of ['heart-3','actor-fan-3','character-fan-3']) {
    const achievement=favorites.achievements.find(item=>item.id===id);
    assert.ok(achievement.unlockedAt,id);
    assert.equal(achievement.current,3);
    assert.equal(achievement.evidence.length,3);
    assert.ok(achievement.evidence.every(value=>value.includes('Série de teste — T3 E')));
  }
  assert.equal((await sync(b.cookie)).achievements.find(item=>item.id==='heart-3').current,0);
  await db.collection('library_items').insertMany(Array.from({length:100},(_,i)=>({ownerId,kind:'movie',status:'completed',title:'Crítica '+i,stars:5})));
  const continuous=await sync();
  const critic=continuous.achievements.find(item=>item.id==='critic-50');
  assert.equal(critic.progressionLevel,0);
  assert.equal(critic.cycleStars,2);
  assert.equal(continuous.achievements.find(item=>item.id==='first-play-1').progressionLevel,0);
  assert.equal(critic.levels,4,'marcos das estrelas permanecem fixos');
  assert.equal(critic.nextLevelTarget,250);
  await db.collection('library_items').deleteMany({ownerId,kind:'movie'});
  const preserved=(await sync()).achievements.find(item=>item.id==='critic-50');
  assert.equal(preserved.current,0);
  assert.equal(preserved.progressionLevel,0);
  assert.equal(preserved.cycleStars,2);
  assert.equal(preserved.nextLevelTarget,250);
  const spec=await (await request('/docs-json')).json();
  await db.collection('library_items').insertMany([
    {ownerId,kind:'game',status:'completed',title:'Jogo A',platform:'PC',playtimeMinutes:599},
    {ownerId,kind:'game',status:'completed',title:'Jogo B',platform:'PS5',playtimeMinutes:1},
    {ownerId,kind:'game',status:'completed',title:'Jogo C',platform:'Switch'},
  ]);
  const gaming=await sync();
  for(const id of ['first-game-1','game-credits-3','game-time-10','game-platforms-3']) assert.ok(gaming.achievements.find(item=>item.id===id).unlockedAt,id);
  assert.equal(gaming.achievements.find(item=>item.id==='game-time-10').current,10);
  assert.equal(gaming.achievements.find(item=>item.id==='game-platforms-3').progressionMode,'finite');
  assert.equal(gaming.achievements.find(item=>item.id==='binge-10').nextLevelTarget,10);
  await db.collection('achievement_awards').insertOne({ownerId,key:'binge-50',unlockedAt:new Date(),evidence:['Histórico preservado']});
  const legacy=await sync();
  assert.equal(legacy.achievements.find(item=>item.id==='binge-50').legacy,true);
  assert.ok(!legacy.pending.includes('binge-50'));
  for(const path of ['/api/achievements','/api/achievements/sync','/api/achievements/title','/api/achievements/celebrations'])assert.ok(spec.paths[path]);
  assert.equal(spec.components.schemas.TitleDto.properties.achievementId.nullable,true);
  assert.equal(spec.components.schemas.AchievementViewDto.properties.unlockedAt.nullable,true);
  assert.equal(spec.components.schemas.AchievementViewDto.properties.evidence.nullable,true);
  assert.equal(spec.components.schemas.AchievementViewDto.properties.current.minimum,0);
  assert.equal(spec.components.schemas.AchievementViewDto.properties.level.minimum,1);
  assert.ok(spec.components.schemas.AchievementViewDto.properties.metric.enum.includes('daySeason'));
});
