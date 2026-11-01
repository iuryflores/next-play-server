# Versionamento e deploy do NextPlay

O frontend e a API possuem workflows independentes em `.github/workflows/ci-release.yml`.
Push em `main` valida, testa e compila; com `DEPLOY_ENABLED=true`, publica por S3 e
SSM Run Command. Pull requests só executam validações, sem credenciais de produção.
O disparo manual permite validar sem publicar ou executar novamente o deploy.

## Destino e portas

Inventário de leitura via SSM em 01/11/2026:

- Região: `us-east-1`.
- Instância: `i-06f4aa3d776a542d9`.
- Usuário: `ubuntu`.
- IP público observado: `184.72.76.142`.
- Domínio: `nextplay.imjsistemas.com.br`.
- A porta `3001` já era usada por outro projeto. As portas `3110` e `3111` estavam livres.
- Node `22.23.3`, PM2 e Certbot já estavam instalados; serviço `pm2-ubuntu` habilitado.

O frontend roda no PM2 como `nextplay-client`, em `127.0.0.1:3110`.
A API roda como `nextplay-api`, em `127.0.0.1:3111`.
O Nginx encaminha `/api` e `/api/*` para a API; os demais caminhos vão para o
frontend, com fallback SPA. Assets inexistentes continuam retornando 404.
As portas e o domínio ficam em `scripts/deploy-settings.json` e nos templates
Nginx dos dois repositórios; mantenha essas cópias sincronizadas ao alterar o destino.

Antes de substituir um processo, o deploy verifica a porta e o diretório PM2.
Um serviço de outro projeto não é encerrado. O lock da EC2 serializa os deploys
de frontend e API mesmo quando os dois repositórios publicam ao mesmo tempo.

## GitHub

Crie o environment `production` nos dois repositórios. Um environment que exija
aprovação manual impedirá publicação totalmente automática até a aprovação.

Environment secrets:

| Secret | Frontend | API |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | Obrigatório | Obrigatório |
| `AWS_SECRET_ACCESS_KEY` | Obrigatório | Obrigatório |
| `APP_ENV_FILE` | Não utilizado | `.env` completo de produção |

Environment variables:

| Variable | Frontend | API |
| --- | --- | --- |
| `AWS_REGION` | `us-east-1` | `us-east-1` |
| `DEPLOY_BUCKET` | Bucket privado de deploy | Pode usar o mesmo bucket |
| `EC2_INSTANCE_ID` | `i-06f4aa3d776a542d9` | Mesmo ID |
| `EC2_USER` | `ubuntu` | `ubuntu` |
| `PM2_APP_NAME` | `nextplay-client` | `nextplay-api` |

Em **Repository variables**, defina `DEPLOY_ENABLED=true` para publicar a cada
push na `main`. O job de deploy consulta essa variável antes de entrar no
environment; não a cadastre somente como environment variable.

Em **Repository secrets**, cadastre `RELEASE_AUTOMATION_TOKEN`, um PAT limitado
aos repositórios do NextPlay com Contents, Issues e Pull requests em Read/write.
O GITHUB_TOKEN do workflow de automerge usa Actions/read e Pull requests/write.
Habilite permitir ao GitHub Actions criar/aprovar PRs nas configurações do repositório.
Se houver proteção da `main`, configure os checks exigidos; a automação não usa bypass.
Configure squash merge para que o título Conventional Commit do PR determine a release.

## APP_ENV_FILE da API

Atualize estes valores no secret antes de publicar:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3111
CLIENT_ORIGIN=https://nextplay.imjsistemas.com.br
ALLOW_REGISTRATION=true
EMAIL_VERIFICATION_REQUIRED=true
SWAGGER_ENABLED=false
```

Inclua também MONGODB_URI do Atlas, configurações Gmail, bucket de fotos e
credenciais dos catálogos já usadas no ambiente local. O deploy recusa um `.env`
de desenvolvimento ou uma porta incompatível antes de parar a versão anterior.
DEPLOY_RELEASE_ID é definido pelo deploy; não precisa colocá-lo no secret.
AWS_REGION dentro do `.env` é a região do bucket de fotos; a variable do GitHub
é a região da EC2 e do bucket de deploy. Podem ser diferentes.

O frontend não usa `.env` nem recebe segredos da API. Seus pedidos usam `/api`
na mesma origem, tanto para autenticação como para links enviados por e-mail.

## S3 e IAM

Use um bucket privado de deploy, preferencialmente separado do `nextplay-ij`
utilizado para fotos. Os pacotes usam `nextplay/client/deployments/*` e
`nextplay/server/deployments/*`, SSE-S3 e checksum SHA-256.

A identidade do GitHub precisa de `s3:PutObject` e `s3:DeleteObject` nesses
prefixos, `ssm:SendCommand` para a instância e documento `AWS-RunShellScript`,
e `ssm:GetCommandInvocation` para acompanhar a execução.
A role da EC2 precisa de `AmazonSSMManagedInstanceCore`, `s3:GetObject` para os
pacotes e das permissões de fotos já configuradas. O SSM Agent precisa estar online.

O artifact do GitHub contém somente `dist` no frontend e `dist`, `package.json`
e `package-lock.json` na API. O `.env` da API é adicionado apenas ao pacote
temporário privado do S3, com permissões locais 600. Não entra no histórico SSM.
Configure lifecycle para remover objetos em `nextplay/*/deployments/` após um
prazo curto, incluindo versões não atuais se o bucket usar versionamento.
O workflow remove o pacote após status terminal; se perder o acompanhamento,
preserva-o para não interromper um comando que ainda esteja executando.

## Primeiro deploy e HTTPS

Pode publicar frontend ou API primeiro. Cada deploy valida seu próprio processo
local e a rota correspondente no Nginx; a aplicação completa exige os dois.
Somente `/etc/nginx/conf.d/nextplay.conf` é gerenciado. Os sites existentes não
são editados nem reiniciados pelo PM2.

Antes de criar o registro DNS, confirme/reserve um Elastic IP para que o destino
não mude após parar/iniciar a EC2. Aponte o registro A do domínio para esse IP.
O IP observado no inventário não comprova uma associação a Elastic IP.

Sem certificado próprio, o deploy prepara HTTP e o diretório ACME
`/var/www/nextplay-acme`. O login de produção exige HTTPS e não funciona só por HTTP.
Após o DNS responder corretamente, em uma sessão SSM na EC2, emita o certificado:

```sh
sudo certbot certonly --webroot -w /var/www/nextplay-acme \
  -d nextplay.imjsistemas.com.br --agree-tos --non-interactive \
  --email SEU_EMAIL_ADMINISTRATIVO
```

Depois execute o workflow manual com `deploy=true` em um dos repositórios.
O script detecta o certificado em `/etc/letsencrypt/live/nextplay.imjsistemas.com.br/`,
habilita HTTPS e redireciona HTTP. Não reutiliza certificados de outros sites.
Confirme a renovação Certbot e o reload do Nginx após renovar.

## Versões, validação e rollback

O Release Please mantém `package.json`, `package-lock.json`, manifesto e changelog.
Use títulos como `feat: adicionar recurso` e `fix: corrigir comportamento`.
PRs de release só são integrados automaticamente quando testes passaram para o
mesmo SHA/base, autor/branch/label estão corretos e as alterações se limitam
aos arquivos de versão, sem modificar dependências. O PAT no merge dispara o
push normal na `main`, seguido do deploy e publicação da tag/release.
Deploy e release são jobs independentes após a validação.

Cada ativação cria `$HOME/nextplay/nextplay-client/releases/<sha-run-attempt>`
ou `$HOME/nextplay/nextplay-server/releases/<sha-run-attempt>`, com symlink
`current`. O processo só é considerado pronto quando o HTTP retorna o ID
exato da release. A API usa `/api/health`; o frontend, `/deploy-meta.json`.

Falha ao iniciar/restaurar HTTP aciona rollback do processo e symlink daquele
aplicativo. Falha no Nginx restaura sua configuração anterior; a versão PM2 que
passou no health check permanece disponível localmente. No primeiro deploy,
não existe versão anterior de aplicativo para restaurar.
Releases antigas e assets com hash ficam preservados para rollback/abas abertas;
aplique uma política de retenção depois de validar a operação.

Validação local: `npm test`, `npm run build`, `npm run check:version` e
`npm run test:deploy`. A API usa bancos temporários no MongoDB local; os testes
de deploy usam AWS/PM2 simulados, sem publicar. Os testes da API que estavam
no frontend foram movidos para o repositório do servidor para permitir CI isolada.

Confira cada deploy em GitHub Actions e pelo CommandId informado no SSM.
Não repita um deploy com status incerto antes de conferir se o comando terminou.
Não publique logs brutos do PM2 ou `.env`: podem conter credenciais de outros apps.
