const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, unlink, rmdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

test('piloto de preços retoma 500 jogos sem repetir consultas concluídas', async t => {
  const { loadGames, runPilot } = await import('../scripts/mercado-livre-price-pilot.mjs');
  const games = await loadGames();
  assert.equal(new Set(games.slice(0, 10).map(game => game.platform)).size, 10);
  const directory = await mkdtemp(join(tmpdir(), 'nextplay-meli-pilot-'));
  const output = join(directory, 'result.json');
  t.after(async () => {
    await unlink(output);
    await rmdir(directory);
  });
  const checked = new Set();
  const search = async game => {
    assert.ok(!checked.has(game.title));
    checked.add(game.title);
    return [{
      id: 'MLB1', seller: { id: 123 },
      title: game.title + ' ' + game.platform + ' físico usado',
      condition: 'used', currency_id: 'BRL', price: 100,
    }];
  };
  const options = { output, batchSize: 25, log() {} };
  const first = await runPilot(games, { ...options, search, limit: 10 });
  assert.equal(first.totals.checked, 10);
  await assert.rejects(runPilot(games, {
    ...options, limit: 500, search: async () => { throw new Error('interrupção simulada'); },
  }), /interrupção simulada/);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).totals.checked, 10);
  const complete = await runPilot(games, { ...options, search, limit: 500 });
  assert.deepEqual(complete.totals, { checked: 500, withComparable: 500, priced: 0, subtotalCents: 0 });
  assert.equal(checked.size, 500);
});

test('triagem exige edição, console, mídia física e vendedores distintos', async () => {
  const { summarize } = await import('../scripts/mercado-livre-price-pilot.mjs');
  const game = { title: 'God of War', platform: 'PS2', edition: 'standard' };
  const listing = (id, price, title, seller = id) => ({
    id: 'MLB' + id, seller: { id: seller }, condition: 'used', currency_id: 'BRL', price, title,
  });
  const valid = 'Jogo God of War PS2 mídia física usado';
  const result = summarize(game, [
    listing(1, 80, valid), listing(2, 100, valid), listing(3, 150, valid),
    listing(4, 200, valid, 1), listing(5, 300, 'God of War II PS2 físico'),
    listing(6, 400, 'God of War Ghost of Sparta PS2 físico'),
    listing(7, 500, 'God of War PS4 remaster físico'),
    listing(8, 600, 'God of War PS2 conta digital'),
  ]);
  assert.equal(result.medianCents, 10000);
  assert.deepEqual(result.comparable.map(item => item.id), ['MLB1', 'MLB2', 'MLB3']);
});

test('cliente respeita Retry-After e interrompe quando a busca é proibida', async () => {
  const { searchClient } = await import('../scripts/mercado-livre-price-pilot.mjs');
  const delays = [];
  const statuses = [429, 403];
  const search = searchClient('token-simulado', {
    pause: async delay => { delays.push(delay); },
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname, '/sites/MLB/search');
      assert.equal(url.searchParams.get('condition'), 'used');
      assert.equal(options.headers.Authorization, 'Bearer token-simulado');
      return new Response(null, { status: statuses.shift(), headers: { 'Retry-After': '3' } });
    },
  });
  await assert.rejects(search({ title: 'Astro Bot', platform: 'PS5' }), /HTTP 403/);
  assert.deepEqual(delays, [1000, 3000, 1000]);
});
