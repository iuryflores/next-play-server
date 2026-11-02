const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const database = 'nextplay_swagger_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test';
process.env.SWAGGER_ENABLED = 'true';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');

test('Swagger serves UI and schemas matching cookie authentication and optional profile uploads', async t => {
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const db = app.get(getConnectionToken());
  t.after(async () => {
    try {
      assert.equal(db.name, database);
      assert.match(database, /^nextplay_swagger_test_[a-f0-9]{32}$/);
      await db.dropDatabase();
    } finally { await app.close(); }
  });
  const base = await app.getUrl();
  const ui = await fetch(base + '/api/docs/');
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /swagger-ui/);
  const response = await fetch(base + '/api/docs-json');
  assert.equal(response.status, 200);
  const spec = await response.json();
  assert.ok(spec.paths['/api/library'].get);
  const explore = spec.paths['/api/library/explore'].get;
  assert.ok(explore.parameters.find(p => p.name === 'kind').schema.enum.includes('book'));
  assert.match(explore.description, /Google Books/);
  assert.match(explore.parameters.find(p => p.name === 'page').description, /50/);
  assert.match(explore.responses['200'].description, /totalPages/);
  assert.deepEqual(spec.paths['/api/library'].get.security, [{ session: [] }]);
  assert.equal(spec.components.securitySchemes.session.in, 'cookie');
  assert.equal(spec.components.securitySchemes.session.name, 'nextplay_session');
  assert.deepEqual(spec.components.schemas.LoginDto.required, ['email', 'password']);
  assert.equal(spec.components.schemas.RegisterDto.properties.password.minLength, 12);
  assert.equal(spec.components.schemas.ProfileDto.required.includes('avatar'), false);
  assert.equal(spec.paths['/api/auth/login'].post.security, undefined);
  assert.ok(spec.paths['/api/auth/avatar'].get.responses['302']);
  assert.ok(spec.components.schemas.ItemDto.properties.kind.enum.length);
});
