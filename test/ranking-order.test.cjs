const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stablePositions } = require('../dist/library/ranking-order');
const { rankingChanges } = require('../dist/library/ranking-snapshot');
test('new arrivals at a tied score stay behind incumbents and movement uses unique positions', () => {
  const top = Object.fromEntries(Array.from({ length: 5 }, (_, i) => ['top' + i, i + 1]));
  const previous = { actors: { ...top, angelina: 6, ian: 7, brad: 25 } };
  const current = { actors: { ...top, angelina: 6, ian: 6, brad: 6 } };
  const next = stablePositions(current, previous);
  assert.equal(next.actors.angelina, 6);
  assert.equal(next.actors.ian, 7);
  assert.equal(next.actors.brad, 8);
  assert.equal(rankingChanges(previous, next).actors.brad, 17);
  assert.equal(rankingChanges(previous, next).actors.ian, 0);
  assert.deepEqual(stablePositions(current, next), next);
  assert.equal(stablePositions({ actors: { brad: 1, angelina: 2, ian: 2 } }, previous).actors.brad, 1);
});
