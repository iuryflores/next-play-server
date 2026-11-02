import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settings, ssmParameters } from '../scripts/deploy-config.mjs';

const posix = path => process.platform === 'win32' ? path.replaceAll('\\', '/').replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`) : path;
const bash = process.env.DEPLOY_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');

test('diagnóstico publica mensagens seguras em linhas reais de stdout e stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextplay-diagnostic-'));
  try {
    const file = join(dir, 'result.json');
    writeFileSync(file, JSON.stringify({ code: 1, stdout: 'ruído\n[nextplay] etapa pública\n', stderr: 'SMTP_PASS=segredo\r\n[nextplay] falha pública\r\n' }));
    const result = spawnSync(process.execPath, ['scripts/deploy-diagnostic.mjs', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /etapa pública/);
    assert.match(result.stdout, /falha pública/);
    assert.ok(!result.stdout.includes('segredo'));
    assert.ok(!result.stdout.includes('ruído'));
  } finally { rmSync(dir, { recursive: true }); }
});
test('comando SSM externo e script interno passam na análise do Bash', () => {
  const command = ssmParameters({ releaseId: 'a'.repeat(40) + '-1-1', bucket: 'test-bucket', region: 'us-east-1', user: 'ubuntu', name: 'nextplay-api', checksum: 'b'.repeat(64) }).commands[0];
  const inner = command.slice("bash -c '".length, -1).replaceAll("'\\''", "'");
  for (const input of [command, inner]) {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-n'], { input, encoding: 'utf8' });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  }
});

test('validação real do pacote SSM aceita arquivos previstos e rejeita caminhos perigosos', () => {
  const command = ssmParameters({ releaseId: 'a'.repeat(40) + '-1-1', bucket: 'test-bucket', region: 'us-east-1', user: 'ubuntu', name: 'nextplay-api', checksum: 'b'.repeat(64) }).commands[0];
  const inner = command.slice("bash -c '".length, -1).replaceAll("'\\''", "'");
  const program = inner.split('\n').find(line => line.startsWith('tar -tzf')).match(/awk '(.+)'$/)[1];
  // Analisar apenas a sintaxe do Bash não executa o parser do AWK usado na EC2.
  for (const [input, expected] of [['application.tar.gz\napp.env\ndeploy-ec2.sh\n', 0], ['../app.env\n', 1], ['/etc/passwd\n', 1], ['unexpected.sh\n', 1]]) {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', 'awk "$1"', 'test', program], { input, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected, result.stderr);
  }
});
function run(status) {
  const dir = mkdtempSync(join(tmpdir(), 'nextplay-runner-'));
  try {
    const result = spawnSync(bash, ['--noprofile', '--norc'], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, RUNNER_TEMP: posix(dir), AWS_LOG: posix(join(dir, 'aws.log')), TERMINAL: status,
        AWS_REGION: 'us-east-1', EC2_INSTANCE_ID: 'i-0123456789abcdef0', DEPLOY_BUCKET: 'test-bucket', EC2_USER: 'ubuntu', PM2_APP_NAME: 'nextplay-api', APP_ENV_FILE: 'SMTP_PASS=segredo-ficticio',
        GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', TEST_KIND: settings.kind },
      input: `set -eu
export PATH="/usr/bin:/bin:$PATH"
export GITHUB_WORKSPACE="$PWD"
# Doubles locais: nunca chama AWS, S3 ou uma EC2 real.
aws() {
  printf '%s\\n' "$*" >> "$AWS_LOG"
  case "$1 $2" in
    's3 cp'|'s3 rm') return 0 ;;
    'ssm send-command') echo 'test-command-id' ;;
    'ssm list-command-invocations') echo '{"stderr":"falha simulada do agente","code":1}' ;;
    'ssm get-command-invocation')
      if [[ "$TERMINAL" == QueryDenied ]]; then echo AccessDeniedException >&2; return 254; fi
      if [[ "$*" == *'--output json'* ]]; then echo '{"stdout":"[nextplay] Falha simulada","stderr":"SMTP_PASS=nao-deve-aparecer"}'; else echo "$TERMINAL"; fi ;;
    *) return 98 ;;
  esac
}
node() { if [[ "$1" == -p ]]; then echo "$TEST_KIND"; fi; return 0; }
cp() { return 0; }
tar() { return 0; }
sha256sum() { echo 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  bundle'; }
source scripts/deploy-ssm-runner.sh
` });
    return { ...result, calls: readFileSync(join(dir, 'aws.log'), 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('runner confirma o alvo e limpa S3 somente depois do término do comando', () => {
  const result = run('Success'); assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /--instance-ids i-0123456789abcdef0/);
  assert.ok(result.calls.includes(`nextplay/${settings.kind}/deployments/`));
  assert.match(result.calls, /--sse AES256/); assert.match(result.calls, /s3 rm/);
  assert.ok(!result.calls.includes('segredo-ficticio'));
});
test('runner falha quando o remoto falha e preserva o pacote se perde o acompanhamento', () => {
  const failed = run('Failed'); assert.equal(failed.status, 1); assert.ok(failed.calls.includes('s3 rm'));
  assert.ok(!failed.stdout.includes('nao-deve-aparecer'));
  const uncertain = run('QueryDenied'); assert.equal(uncertain.status, 1); assert.ok(!uncertain.calls.includes('s3 rm'));
});
