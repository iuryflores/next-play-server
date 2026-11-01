const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CatalogService } = require('../dist/catalog/catalog.module');
test('catalog preserves release dates for movies, series and games and undated production status', () => {
  const service = Object.create(CatalogService.prototype);
  const movie = service.movie({ id: 1, title: 'Movie', release_date: '2099-06-15' }, 'movie');
  assert.equal(movie.releaseDate, '2099-06-15'); assert.equal(movie.year, '2099');
  const series = service.movie({ id: 2, name: 'Series', first_air_date: '2099-06-16' }, 'series'); assert.equal(series.releaseDate, '2099-06-16');
  const undated = service.movie({ id: 3, title: 'Movie', status: 'In Production' }, 'movie'); assert.equal(undated.unreleased, true); assert.equal(undated.releaseDate, '');
  const game = service.game({ id: 4, name: 'Game', first_release_date: Date.parse('2099-06-17T00:00:00Z') / 1000 }); assert.equal(game.releaseDate, '2099-06-17');
});
