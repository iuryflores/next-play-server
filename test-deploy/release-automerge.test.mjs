import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReleaseFiles, assertVersionOnly, automateRelease, releaseBranch } from '../scripts/release-automerge.mjs';

const versionFiles = version => ({ package: { name: 'nextplay-server', version, dependencies: { example: '1.0.0' } },
  lock: { version, packages: { '': { version, dependencies: { example: '1.0.0' } }, 'node_modules/example': { version: '1.0.0', integrity: 'original' } } },
  manifest: { '.': version } });
const files = ['package.json', 'package-lock.json', '.release-please-manifest.json', 'CHANGELOG.md'].map(filename => ({ filename, status: 'modified' }));

function fixture() {
  const repo = 'example/api', runId = 42;
  const pr = { number: 1, state: 'open', draft: false, user: { login: 'example' }, title: 'chore(main): release 1.1.0',
    labels: [{ name: 'autorelease: pending' }], base: { ref: 'main', sha: 'base', repo: { full_name: repo } },
    head: { ref: releaseBranch, sha: 'tested', repo: { full_name: repo } } };
  const run = { id: runId, event: 'pull_request', conclusion: 'success', path: '.github/workflows/ci-release.yml',
    head_repository: { full_name: repo }, head_branch: releaseBranch, head_sha: 'tested', pull_requests: [{ number: 1, base: { sha: 'base' } }] };
  const state = { pr, run, files: structuredClone(files), base: versionFiles('1.0.0'), next: versionFiles('1.1.0'),
    latest: run, reviews: [], calls: [], main: 'base', merged: true, changed: false };
  let reads = 0;
  const request = async (path, options) => {
    state.calls.push({ path, ...options });
    if (options.method === 'POST') return {};
    if (options.method === 'PUT') return { merged: state.merged };
    if (path.endsWith('/actions/runs/42')) return state.run;
    if (path.includes('/actions/workflows/')) return { workflow_runs: [state.latest] };
    if (path.includes('/pulls?')) return [state.pr];
    if (path.endsWith('/pulls/1')) {
      reads++;
      return structuredClone(reads > 1 && state.changed ? { ...state.pr, head: { ...state.pr.head, sha: 'untested' } } : state.pr);
    }
    if (path.includes('/files?')) return state.files;
    if (path.includes('/reviews?')) return state.reviews;
    if (path.endsWith('/git/ref/heads/main')) return { object: { sha: state.main } };
    if (path.includes('/contents/')) {
      const [filename, sha] = path.split('/contents/')[1].split('?ref=');
      const key = { 'package.json': 'package', 'package-lock.json': 'lock', '.release-please-manifest.json': 'manifest' }[filename];
      return { content: Buffer.from(JSON.stringify((sha === 'base' ? state.base : state.next)[key])).toString('base64') };
    }
    throw new Error(`Consulta inesperada: ${path}`);
  };
  return { state, run: () => automateRelease({ repo, runId, token: 'bot-test', mergeToken: 'pat-test', request }) };
}

test('aprova o SHA testado com o bot e integra via PAT para disparar o push normal', async () => {
  const f = fixture();
  assert.match(await f.run(), /Release 1.1.0 integrada/);
  const writes = f.state.calls.filter(call => call.method);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].token, 'bot-test');
  assert.deepEqual(writes[0].body, { event: 'APPROVE', commit_id: 'tested' });
  assert.equal(writes[1].token, 'pat-test');
  assert.deepEqual(writes[1].body, { sha: 'tested', merge_method: 'squash', commit_title: 'chore(main): release 1.1.0' });
});

test('PR legado criado pelo bot usa identidade distinta na aprovação', async () => {
  const f = fixture(); f.state.pr.user.login = 'github-actions[bot]';
  await f.run();
  assert.equal(f.state.calls.find(call => call.method === 'POST').token, 'pat-test');
});

test('não duplica aprovação já existente no mesmo commit', async () => {
  const f = fixture(); f.state.reviews = [{ state: 'APPROVED', commit_id: 'tested' }];
  await f.run();
  assert.equal(f.state.calls.some(call => call.method === 'POST'), false);
});

for (const [name, mutate] of [
  ['teste falhou', s => { s.run.conclusion = 'failure'; }],
  ['workflow diferente', s => { s.run.path = '.github/workflows/other.yml'; }],
  ['fork', s => { s.pr.head.repo.full_name = 'other/api'; }],
  ['branch diferente', s => { s.pr.head.ref = 'feature'; }],
  ['autor diferente', s => { s.pr.user.login = 'intruder'; }],
  ['sem label de release', s => { s.pr.labels = []; }],
  ['código no PR', s => { s.files.push({ filename: 'src/main.ts', status: 'modified' }); }],
  ['dependência modificada', s => { s.next.lock.packages['node_modules/example'].integrity = 'different'; }],
  ['SHA não testado', s => { s.pr.head.sha = 'untested'; }],
  ['PR atualizado durante conferência', s => { s.changed = true; }],
  ['base avançou', s => { s.main = 'advanced'; }],
  ['testes executados contra outra base', s => { s.run.pull_requests[0].base.sha = 'old'; }],
  ['validação mais recente', s => { s.latest = { ...s.run, id: 43, conclusion: 'failure' }; }],
  ['revisão solicita alterações', s => { s.reviews = [{ state: 'CHANGES_REQUESTED' }]; }],
  ['título diverge da versão', s => { s.pr.title = 'chore(main): release 2.0.0'; }],
]) {
  test(`bloqueia integração: ${name}`, async () => {
    const f = fixture(); mutate(f.state);
    await assert.rejects(f.run());
    assert.equal(f.state.calls.some(call => call.method), false);
  });
}

test('não declara sucesso se o GitHub recusar o merge', async () => {
  const f = fixture(); f.state.merged = false;
  await assert.rejects(f.run(), /não confirmou/);
});

test('versão permite somente incremento consistente sem alterar dependências', () => {
  assert.equal(assertVersionOnly(versionFiles('1.0.0'), versionFiles('1.1.0')), '1.1.0');
  for (const version of ['1.0.0', '0.9.9', '1.1.0-beta.1', '01.1.0'])
    assert.throws(() => assertVersionOnly(versionFiles('1.0.0'), versionFiles(version)));
  const next = versionFiles('1.1.0'); next.manifest['.'] = '2.0.0';
  assert.throws(() => assertVersionOnly(versionFiles('1.0.0'), next));
  const changed = versionFiles('1.1.0'); changed.package.dependencies.example = '2.0.0';
  assert.throws(() => assertVersionOnly(versionFiles('1.0.0'), changed));
});

test('arquivos renomeados ou excluídos não podem ser integrados automaticamente', () => {
  assertReleaseFiles(files);
  assertReleaseFiles(files.map(file => file.filename === 'CHANGELOG.md' ? { ...file, status: 'added' } : file));
  for (const status of ['removed', 'renamed'])
    assert.throws(() => assertReleaseFiles(files.map(file => ({ ...file, status }))));
});
