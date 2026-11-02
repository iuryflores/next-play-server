// Este cenário testa o fluxo legado; confirmação obrigatória tem suíte própria.
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const database = 'nextplay_friends_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.CLIENT_ORIGIN = 'http://localhost:5174'; process.env.NODE_ENV = 'test'; process.env.ALLOW_REGISTRATION = 'true';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { Types } = require('mongoose');
test('friend acceptance gates rankings, ranks time fairly and supports removal', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1'); const base = await app.getUrl(); const db = app.get(getConnectionToken());
  t.after(async () => { try { assert.match(database, /^nextplay_friends_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const call = (path, method = 'GET', body, cookie, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = async email => { const r = await call('/auth/register', 'POST', { email, password: 'Long-test-password-123!' }); assert.equal(r.status, 201); return { cookie: r.headers.get('set-cookie').split(';')[0], id: (await r.json()).user.id }; };
  const a = await register('a@example.test'), b = await register('b@example.test'), c = await register('c@example.test');
  // A assinatura é simulada para validar fotos sem acessar o S3 durante o teste.
  const {AvatarStorage}=require('../dist/auth/avatar-storage');
  app.get(AvatarStorage).signedUrl=async key=>'https://example.test/photo.jpg?key='+encodeURIComponent(key);
  await db.collection('users').updateOne({_id:new Types.ObjectId(b.id)},{$set:{avatarKey:'uploads/avatars/test.jpg'}});
  assert.equal((await call('/friends')).status, 401);
  assert.equal((await call('/friends/profile', 'POST', { name: 'Alex' }, a.cookie)).status, 204);
  assert.equal((await call('/friends/requests', 'POST', { code: a.id }, a.cookie)).status, 400);
  assert.equal((await call('/friends/requests', 'POST', { code: 'bad' }, a.cookie)).status, 400);
  assert.equal((await call('/friends/requests', 'POST', { code: b.id }, a.cookie, 'https://evil.example')).status, 403);
  assert.equal((await call('/friends/requests', 'POST', { code: b.id }, a.cookie)).status, 204);
  assert.equal((await call('/friends/requests', 'POST', { code: a.id }, b.cookie)).status, 409);
  let data = await (await call('/friends', 'GET', undefined, a.cookie)).json();
  const id = data.connections[0].id; assert.equal(data.ranking.length, 1); assert.equal(data.name, 'Alex'); assert.ok(!JSON.stringify(data).includes('@'));
  assert.equal((await call('/friends/' + id + '/accept', 'POST', undefined, a.cookie)).status, 404);
  assert.equal((await call('/friends/' + id + '/accept', 'POST', undefined, c.cookie)).status, 404);
  assert.equal((await call('/friends/' + id + '/accept', 'POST', undefined, b.cookie)).status, 204);
  data = await (await call('/friends', 'GET', undefined, a.cookie)).json(); assert.equal(data.ranking.length, 2); assert.deepEqual(data.ranking.map(row => row.rank), [1, 2]); assert.equal(data.ranking[0].id, a.id);
  const itemId = new Types.ObjectId();
  await db.collection('library_items').insertOne({ _id: itemId, ownerId: new Types.ObjectId(b.id), title: 'Private title', kind: 'series', status: 'active', catalogId: 'tmdb:series:22', notes: 'secret' });
  await db.collection('series_seasons').insertOne({ catalogId: 'tmdb:series:22', number: 1, episodes: [{ number: 1, runtime: 45 }, { number: 2 }] });
  await db.collection('episode_progress').insertMany([{ itemId, season: 1, episode: 1, watchedAt: new Date() }, { itemId, season: 1, episode: 2, watchedAt: new Date() }]);
  data = await (await call('/friends', 'GET', undefined, a.cookie)).json();
  assert.equal(data.ranking[0].id, b.id); assert.equal(data.ranking[0].minutes, 45); assert.equal(data.ranking[0].episodes, 2); assert.equal(data.ranking[0].incomplete, true); assert.equal(data.ranking[1].rank, 2); assert.ok(!JSON.stringify(data).includes('Private title')); assert.ok(!JSON.stringify(data).includes('secret'));
  assert.equal((await call('/friends?scope=all')).status,401);
  assert.equal((await call('/friends?scope=invalid','GET',undefined,a.cookie)).status,400);
  await db.collection('achievement_profiles').insertOne({ownerId:new Types.ObjectId(b.id),selectedId:'cinephile-100',peaks:{movies:338}});
  await db.collection('achievement_awards').insertOne({ownerId:new Types.ObjectId(b.id),key:'cinephile-100',unlockedAt:new Date(),evidence:['Evidência privada']});
  const global=await (await call('/friends?scope=all','GET',undefined,a.cookie)).json();
  assert.equal(global.ranking.length,3,'ranking geral inclui usuários sem amizade');
  assert.equal(global.ranking[0].id,b.id);
  assert.match(global.ranking[0].avatar,/^https:\/\/example.test\/photo.jpg/);
  assert.equal(global.ranking[0].connection.status,'accepted');
  assert.equal(global.ranking.find(row=>row.id===c.id).connection,null);
  assert.equal(global.ranking.find(row=>row.id===c.id).avatar,'');
  assert.equal(global.ranking[0].achievement.title,'Cinéfilo');
  assert.equal(global.ranking[0].achievement.cycleStars,3.38);
  assert.equal(global.ranking[0].achievement.progressionLevel,0);
  assert.equal(global.ranking.find(row=>row.id===c.id).achievement,null);
  for(const privateValue of ['@','Private title','secret','Evidência privada']) assert.ok(!JSON.stringify(global).includes(privateValue));
  const friendRanking=await (await call('/friends','GET',undefined,a.cookie)).json();
  assert.equal(friendRanking.ranking.length,2);
  assert.equal(friendRanking.ranking[0].achievement.title,'Cinéfilo');
  // Os novos indicadores publicam somente totais, com identidade distinta e escopos preservados.
  await db.collection('library_items').insertMany([
    {ownerId:new Types.ObjectId(b.id),kind:'book',status:'completed',title:'Livro privado',catalogKey:'local:book:one',archived:true},
    {ownerId:new Types.ObjectId(b.id),kind:'book',status:'completed',title:'Cópia duplicada',catalogKey:'local:book:one'},
    {ownerId:new Types.ObjectId(b.id),kind:'game',status:'completed',title:'Jogo privado',catalogKey:'local:game:one',playtimeMinutes:60},
    {ownerId:new Types.ObjectId(b.id),kind:'book',status:'active',title:'Leitura em andamento'},
    {ownerId:new Types.ObjectId(b.id),kind:'game',status:'planned',title:'Planejado privado'},
    {ownerId:new Types.ObjectId(c.id),kind:'book',status:'completed',title:'Livro de outra conta'},
  ]);
  const beforeXp=await (await call('/friends?scope=all','GET',undefined,a.cookie)).json();
  assert.equal(beforeXp.ranking.find(row=>row.id===b.id).xp,0,'consultar ranking não concede XP');
  const xpResponse=await call('/progression/sync','POST',{},b.cookie);
  assert.equal(xpResponse.status,200);
  const xpState=await xpResponse.json();
  for(const scope of ['friends','all']) {
    const summary=await (await call('/friends?scope='+scope,'GET',undefined,a.cookie)).json();
    const row=summary.ranking.find(row=>row.id===b.id);
    assert.equal(row.books,1,'livros concluídos distintos, inclusive arquivados');
    assert.equal(row.games,1,'planejados não contam como concluídos');
    assert.equal(row.xp,xpState.totalXp); assert.equal(row.level,xpState.level);
    assert.equal(summary.ranking.find(row=>row.id===a.id).books,0);
    assert.equal(summary.ranking.find(row=>row.id===a.id).games,0);
    assert.equal(summary.ranking.find(row=>row.id===a.id).xp,0);
    assert.equal(row.rank,1,'novas colunas preservam a ordenação por tempo');
    assert.equal(summary.ranking.some(row=>row.id===c.id),scope==='all');
    if(scope==='all') assert.equal(summary.ranking.find(row=>row.id===c.id).books,1);
    for(const privateValue of ['Livro privado','Jogo privado','Cópia duplicada','Livro de outra conta','recordedAt','Evidência privada']) assert.ok(!JSON.stringify(summary).includes(privateValue));
  }
  assert.ok(await db.collection('ranking_visits').findOne({_id:a.id+':users'}));
  assert.ok(await db.collection('ranking_visits').findOne({_id:a.id+':friends'}));
  assert.equal((await call('/friends/' + id, 'DELETE', undefined, c.cookie)).status, 404);
  assert.equal((await call('/friends/' + id, 'DELETE', undefined, a.cookie)).status, 204);
  assert.equal((await (await call('/friends', 'GET', undefined, b.cookie)).json()).ranking.length, 1);
  assert.equal((await call('/friends/requests', 'POST', { code: c.id }, a.cookie)).status, 204);
  const pending = (await (await call('/friends', 'GET', undefined, c.cookie)).json()).connections[0];
  assert.equal(pending.incoming, true); assert.equal((await call('/friends/' + pending.id, 'DELETE', undefined, c.cookie)).status, 204);
  // Convite direto usa o ID retornado pelo ranking, sem o usuário precisar digitá-lo.
  const directory=await (await call('/friends?scope=all','GET',undefined,a.cookie)).json();
  const target=directory.ranking.find(row=>row.id===c.id);
  assert.equal((await call('/friends/requests','POST',{code:target.id},a.cookie)).status,204);
  const outgoing=await (await call('/friends?scope=all','GET',undefined,a.cookie)).json();
  assert.equal(outgoing.ranking.find(row=>row.id===c.id).connection.incoming,false);
  assert.equal(outgoing.ranking.find(row=>row.id===c.id).connection.status,'pending');
  const incoming=await (await call('/friends?scope=all','GET',undefined,c.cookie)).json();
  assert.equal(incoming.ranking.find(row=>row.id===a.id).connection.incoming,true);
});

