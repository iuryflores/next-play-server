const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
// Banco local exclusivo: a validação não altera prioridades de usuários reais.
const database = 'nextplay_priority_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test'; process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true'; process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
test('prioridade persiste em todas as mídias e não modifica o acompanhamento', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(), db = app.get(getConnectionToken());
  t.after(async () => { try { assert.match(database, /^nextplay_priority_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const call = (path, method = 'GET', cookie, body, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = async name => { const r = await call('/auth/register', 'POST', undefined, { email: name + '@example.test', password: 'Long-test-password-123!' }); assert.equal(r.status, 201); return r.headers.get('set-cookie').split(';')[0]; };
  const a = await register('priority-a'), b = await register('priority-b');
  for (const kind of ['movie', 'series', 'book', 'game']) {
    let r = await call('/library', 'POST', a, { title: 'Obra ' + kind, kind, status: 'planned', notes: 'Notas privadas', ...(kind === 'game' ? { platform: 'PC', playtimeMinutes: 120 } : {}) });
    assert.equal(r.status, 201); const item = (await r.json()).item;
    assert.equal(item.priority, 'none'); const path = `/library/${item.id}/priority`;
    assert.equal((await call(path, 'PATCH', undefined, { priority: 'high' })).status, 401);
    assert.equal((await call(path, 'PATCH', b, { priority: 'high' })).status, 404);
    assert.equal((await call(path, 'PATCH', a, { priority: 'high' }, 'https://evil.example')).status, 403);
    for (const body of [{ priority: 'invalid' }, { priority: null }, {}, { priority: 'high', status: 'completed' }]) assert.equal((await call(path, 'PATCH', a, body)).status, 400);
    for (const priority of ['high', 'medium', 'low', 'none']) {
      r = await call(path, 'PATCH', a, { priority }); assert.equal(r.status, 200);
      const updated = (await r.json()).item;
      assert.equal(updated.priority, priority); assert.equal(updated.notes, item.notes); assert.equal(updated.status, item.status);
      if (kind === 'game') { assert.equal(updated.playtimeMinutes, 120); assert.equal(updated.platform, 'PC'); }
    }
    await call(path, 'PATCH', a, { priority: 'high' });
    r = await call(`/library/${item.id}`, 'PATCH', a, { title: item.title, kind, status: 'planned', notes: item.notes });
    assert.equal(r.status, 200); assert.equal((await r.json()).item.priority, 'high', 'edição sem prioridade preserva a escolha');
    const saved = (await (await call('/library', 'GET', a)).json()).items.find(row => row.id === item.id);
    assert.equal(saved.priority, 'high');
    if (kind === 'game') {
      await call(`/library/${item.id}/game-sessions`, 'POST', a, { id: randomUUID(), mode: 'add', minutes: 30, playedOn: '2026-10-01' });
      await call(path, 'PATCH', a, { priority: 'low' });
      const history = await (await call(`/library/${item.id}/game-sessions`, 'GET', a)).json();
      assert.equal(history.sessionCount, 1); assert.equal(history.playtimeMinutes, 150); assert.equal(history.lastPlayedOn, '2026-10-01');
    }
  }
  const created = await (await call('/library', 'POST', a, { title: 'Cadastro prioritário', kind: 'book', status: 'planned', priority: 'medium' })).json();
  assert.equal(created.item.priority, 'medium');
  assert.equal(await db.collection('user_xp_credits').countDocuments(), 0, 'priorizar não concede XP');
});
