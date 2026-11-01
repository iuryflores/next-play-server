const title = process.env.PR_TITLE ?? process.argv[2] ?? '';
// Com squash merge, o título do PR vira o commit que o Release Please analisa.
// Não calculamos versões aqui: essa regra fica com a ferramenta de release.
const conventional = /^(feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert)(\([^()\r\n]+\))?!?: [^\r\n]+$/u;
if (!conventional.test(title)) {
  console.error('Use um título Conventional Commit: feat: descrição, fix: descrição ou feat!: mudança incompatível.');
  process.exitCode = 1;
} else {
  console.log('Título Conventional Commit válido.');
}
