import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

export const releaseBranch = 'release-please--branches--main--components--nextplay-server';
const releaseFiles = ['.release-please-manifest.json', 'CHANGELOG.md', 'package-lock.json', 'package.json'];

export function assertReleaseFiles(files) {
  if (!isDeepStrictEqual(files.map(file => file.filename).sort(), releaseFiles) ||
      files.some(file => file.status !== 'modified' && !(file.filename === 'CHANGELOG.md' && file.status === 'added')))
    throw new Error('O PR contém alterações fora dos arquivos de versão permitidos.');
}

export function assertVersionOnly(base, next) {
  const version = next.package.version;
  const parse = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    ? value.split('.').map(Number) : null;
  const oldParts = parse(base.package.version), newParts = parse(version);
  const firstDifference = oldParts && newParts ? newParts.findIndex((part, index) => part !== oldParts[index]) : -1;
  if (firstDifference < 0 || newParts[firstDifference] <= oldParts[firstDifference])
    throw new Error('A release deve aumentar uma versão semântica estável.');
  // Não basta permitir package-lock: uma alteração de dependência nesse arquivo
  // poderia introduzir código em um PR que seria aprovado automaticamente.
  const normalized = structuredClone(next);
  normalized.package.version = base.package.version;
  normalized.lock.version = base.lock.version;
  normalized.lock.packages[''].version = base.lock.packages[''].version;
  normalized.manifest['.'] = base.manifest['.'];
  if (!isDeepStrictEqual(normalized, base) || next.lock.version !== version ||
      next.lock.packages[''].version !== version || next.manifest['.'] !== version)
    throw new Error('O PR altera mais que a versão ou possui versões divergentes.');
  return version;
}

export async function automateRelease({ repo, runId, token, mergeToken, request }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(String(runId)) || !token || !mergeToken)
    throw new Error('Configuração obrigatória da automação de release ausente.');
  const api = (path, options = {}) => request(`/repos/${repo}${path}`, { token, ...options });
  const run = await api(`/actions/runs/${runId}`);
  if (run.event !== 'pull_request' || run.conclusion !== 'success' || run.path !== '.github/workflows/ci-release.yml' ||
      run.head_repository?.full_name !== repo || run.head_branch !== releaseBranch)
    throw new Error('Execução não corresponde à validação de um PR de release confiável.');
  const prs = await api(`/pulls?state=open&base=main&head=${encodeURIComponent(repo.split('/')[0] + ':' + releaseBranch)}&per_page=100`);
  if (prs.length !== 1) return 'Nenhum PR de release único aberto; nada foi integrado.';
  const number = prs[0].number;
  const trusted = pr => pr.state === 'open' && !pr.draft && pr.base.ref === 'main' &&
    pr.base.repo.full_name === repo && pr.head.repo?.full_name === repo && pr.head.ref === releaseBranch &&
    pr.head.sha === run.head_sha && ['github-actions[bot]', repo.split('/')[0]].includes(pr.user.login) &&
    /^chore\(main\): release \d+\.\d+\.\d+$/.test(pr.title) && pr.labels.some(label => label.name === 'autorelease: pending');
  const pr = await api(`/pulls/${number}`);
  if (!trusted(pr)) throw new Error('O PR não corresponde à release e ao SHA que passaram nos testes.');
  const latest = await api(`/actions/workflows/ci-release.yml/runs?event=pull_request&head_sha=${run.head_sha}&per_page=100`);
  const latestRun = latest.workflow_runs.filter(item => item.head_branch === releaseBranch).sort((a, b) => b.id - a.id)[0];
  if (latestRun?.id !== Number(runId) || latestRun.conclusion !== 'success')
    throw new Error('Existe uma validação mais recente ou ainda não aprovada para esse SHA.');
  const files = await api(`/pulls/${number}/files?per_page=100`);
  assertReleaseFiles(files);
  const readVersionFiles = async sha => {
    const read = async path => {
      const file = await api(`/contents/${path}?ref=${sha}`);
      return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    };
    const [pkg, lock, manifest] = await Promise.all([read('package.json'), read('package-lock.json'), read('.release-please-manifest.json')]);
    return { package: pkg, lock, manifest };
  };
  const [base, next] = await Promise.all([readVersionFiles(pr.base.sha), readVersionFiles(pr.head.sha)]);
  const version = assertVersionOnly(base, next);
  if (pr.title !== `chore(main): release ${version}`) throw new Error('Título da release diverge da versão validada.');
  // Reconfere a referência após as leituras; SHA no merge impede integrar uma
  // atualização do robô que ainda não passou pela validação. Não usa bypass.
  const current = await api(`/pulls/${number}`);
  if (!trusted(current) || current.base.sha !== pr.base.sha) throw new Error('O PR mudou durante a conferência.');
  const main = await api('/git/ref/heads/main');
  const testedBase = run.pull_requests?.find(item => item.number === number)?.base?.sha;
  if (main.object.sha !== pr.base.sha || testedBase !== pr.base.sha) {
    // Atualizar a branch gera synchronize e testa o merge com a main atual; jamais integra uma base não validada.
    await api(`/pulls/${number}/update-branch`, { method: 'PUT', token: mergeToken, body: { expected_head_sha: pr.head.sha } });
    return 'A main mudou: branch da release atualizada para executar novamente os testes do PR. Integração aguarda nova validação.';
  }
  const reviews = await api(`/pulls/${number}/reviews?per_page=100`);
  if (reviews.some(review => review.state === 'CHANGES_REQUESTED'))
    throw new Error('Existe uma solicitação de alterações; a integração automática foi interrompida.');
  if (!reviews.some(review => review.state === 'APPROVED' && review.commit_id === pr.head.sha)) {
    // O bot não aprova o próprio PR legado. Nesse único caso, a identidade do
    // PAT revisa; nos PRs novos, criados pelo PAT, o GITHUB_TOKEN faz a revisão.
    await api(`/pulls/${number}/reviews`, { method: 'POST',
      token: pr.user.login === 'github-actions[bot]' ? mergeToken : token,
      body: { event: 'APPROVE', commit_id: pr.head.sha } });
  }
  // O PAT no merge gera push normal na main, acionando CI, deploy e a criação
  // da tag/release pelo Release Please. GITHUB_TOKEN suprimiria esse evento.
  const merged = await api(`/pulls/${number}/merge`, { method: 'PUT', token: mergeToken,
    body: { sha: pr.head.sha, merge_method: 'squash', commit_title: pr.title } });
  if (!merged.merged) throw new Error('O GitHub não confirmou a integração da release.');
  return `Release ${version} integrada após validação bem-sucedida (PR #${number}).`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await automateRelease({ repo: process.env.GITHUB_REPOSITORY, runId: process.env.RELEASE_RUN_ID,
      token: process.env.GH_TOKEN, mergeToken: process.env.RELEASE_AUTOMATION_TOKEN,
      request: async (path, { token, method = 'GET', body }) => {
        const response = await fetch(`https://api.github.com${path}`, { method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`GitHub recusou a operação da release (HTTP ${response.status}).`);
        return response.json();
      } });
    console.log(result);
  } catch (error) {
    // Não imprime request/headers/respostas da API: podem carregar credenciais.
    console.error(error instanceof Error ? error.message : 'Falha na automação de release.');
    process.exitCode = 1;
  }
}
