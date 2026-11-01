import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ssmParameters, previousConfig, assertPortOwner, releaseConfig, settings } from '../scripts/deploy-config.mjs';

const releaseId = 'a'.repeat(40) + '-42-1';
const input = { releaseId, bucket: 'nextplay-deploy-example', region: 'us-east-1', user: 'ubuntu', name: `nextplay-${settings.kind}`, checksum: 'b'.repeat(64) };

test('SSM usa prefixo próprio, checksum, usuário sem root e lock compartilhado sem segredos', () => {
  const result = ssmParameters(input);
  assert.equal(result.executionTimeout[0], '900');
  const command = result.commands[0];
  for (const part of ['/var/lock/nextplay-deploy.lock', `nextplay/${settings.kind}/deployments/`, 'sha256sum', 'runuser', 'configure-nginx.sh']) assert.ok(command.includes(part));
  assert.ok(!command.includes('SMTP_PASS'));
  for (const [key, value] of [['user', 'root'], ['user', "ubuntu';id"], ['bucket', 'bucket;id'], ['region', 'us-east-1$(id)'], ['name', 'other-app'], ['releaseId', '../etc'], ['checksum', 'not-a-hash']]) assert.throws(() => ssmParameters({ ...input, [key]: value }));
});
test('snapshot e porta impedem substituir outro aplicativo da EC2', () => {
  const root = '/home/ubuntu/nextplay/nextplay-client';
  const existing = [{ name: input.name, pid: 42, pm2_env: { pm_cwd: root + '/releases/old', exec_mode: 'fork_mode', pm_exec_path: '/node/app.js', env: {} } }];
  assert.equal(previousConfig(existing, input.name, root).apps.length, 1);
  assert.throws(() => previousConfig(existing, input.name, '/other-app'));
  assertPortOwner('LISTEN users:(("node",pid=42,fd=10))', existing, input.name);
  assert.throws(() => assertPortOwner('LISTEN users:(("node",pid=43,fd=10))', existing, input.name));
  assert.throws(() => assertPortOwner('LISTEN', [], input.name));
  assertPortOwner('', [], input.name);
});
test('PM2 usa porta reservada, loopback, processo exclusivo e .env sem duplicar segredos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextplay-config-'));
  try {
    if (settings.kind === 'server') writeFileSync(join(dir, '.env'), `NODE_ENV=production\nCLIENT_ORIGIN=https://${settings.domain}\nMONGODB_URI=mongodb://example/nextplay\nPORT=3111\nSMTP_PASS=segredo-exemplo\n`);
    const app = releaseConfig(dir, input.name, releaseId).apps[0];
    assert.equal(app.env.PORT, String(settings.port)); assert.equal(app.env.HOST, '127.0.0.1');
    assert.equal(app.env.DEPLOY_RELEASE_ID, releaseId); assert.equal(app.watch, false);
    assert.ok(!JSON.stringify(app).includes('segredo-exemplo'));
    if (settings.kind === 'server') {
      assert.deepEqual(app.node_args, [`--env-file=${dir}/.env`]);
      writeFileSync(join(dir, '.env'), 'NODE_ENV=development\nPORT=3001\n');
      assert.throws(() => releaseConfig(dir, input.name, releaseId));
    }
  } finally { rmSync(dir, { recursive: true }); }
});
test('Nginx mantém API fora do fallback SPA e reserva arquivo exclusivo do domínio', () => {
  for (const file of ['nginx-http.conf', 'nginx-https.conf']) {
    const config = readFileSync(new URL(`../deploy/nginx/${file}`, import.meta.url), 'utf8');
    assert.ok(config.includes('server_name nextplay.imjsistemas.com.br;'));
    assert.ok(config.includes('location /api/ {'));
    assert.ok(config.includes('proxy_pass http://127.0.0.1:3111;'));
    assert.ok(config.includes('proxy_pass http://127.0.0.1:3110;'));
    assert.ok(!config.includes('default_server'));
    assert.ok(!config.includes('$request"'));
  }
});
