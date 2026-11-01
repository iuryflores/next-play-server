import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readJson = file => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const manifest = readJson('.release-please-manifest.json');

// Confere também a raiz do lockfile: mudar só seu campo externo deixa npm ci
// e as ferramentas de release com fontes divergentes para a versão do projeto.
assert.equal(lock.version, pkg.version, 'Versão externa do lockfile divergente');
assert.equal(lock.packages[''].version, pkg.version, 'Versão raiz do lockfile divergente');
assert.equal(manifest['.'], pkg.version, 'Manifesto de release divergente');
console.log(`Versão sincronizada: ${pkg.version}`);
