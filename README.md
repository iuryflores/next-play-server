# NextPlay API — NestJS + MongoDB

Backend separado do frontend Vite, feito com NestJS, Node.js, TypeScript e Mongoose. O MongoDB precisa estar em execução.

```sh
npm install
npm run dev
```

Por padrão, a API usa `http://127.0.0.1:3001/api` e o banco `mongodb://127.0.0.1:27017/nextplay`. `npm run build` compila; `npm start` inicia o build. Requer Node.js 22.13 ou superior.

Copie `.env.example` para `.env` se precisar mudar a configuração. `CLIENT_ORIGIN` deve corresponder à URL do Vite (atualmente `http://localhost:5174`). O frontend encaminha `/api` para a API; não é necessário expor credenciais ou URI do MongoDB ao frontend. Não há credenciais padrão nem conta previamente criada: use **Criar conta** na tela.

## Estrutura

- `src/main.ts` e `src/bootstrap.ts`: inicialização, cookies e validação.
- `src/app.module.ts`: conexão MongoDB e módulos.
- `src/auth/auth.module.ts`: módulo de autenticação.
- `src/auth/auth.controller.ts`: endpoints.
- `src/auth/auth.service.ts`: usuários e sessões.
- `src/auth/auth.schemas.ts`: modelos Mongoose e índices.
- `src/auth/auth.dto.ts`: validação e normalização.
- `src/auth/auth.guard.ts`: verificação de origem e limite de tentativas no MongoDB.

## Endpoints

## Swagger / OpenAPI

Abra `http://localhost:5174/api/docs` com o Vite e a API ativos. A especificação
JSON está em `/api/docs-json`. As rotas são agrupadas por módulo e os DTOs
documentam tipos, campos opcionais e limites de validação.

Para testar, execute `POST /api/auth/login` pelo Swagger. O navegador recebe o
cookie HttpOnly automaticamente; as próximas chamadas usam a mesma sessão.
Não é necessário preencher Authorize ou fornecer um JWT. Use a origem do Vite
configurada em `CLIENT_ORIGIN`: abrir diretamente `http://127.0.0.1:3001/api/docs`
permite consultar a documentação, mas mutações são rejeitadas se a origem diferir.
Logout pelo Swagger também encerra a sessão do app nesse navegador.

Swagger está ativo por padrão em desenvolvimento. `SWAGGER_ENABLED=false`
desativa a interface e o JSON; em produção só é habilitado explicitamente com
`SWAGGER_ENABLED=true`. Os exemplos não contêm credenciais reais.

Os comentários de código explicam decisões e regras de negócio. Ao alterar
endpoints, mantenha os decorators OpenAPI e os comentários relevantes atualizados.

### Referência de endpoints

| Método | Caminho | Corpo / resultado |
| --- | --- | --- |
| GET | `/api/health` | Estado da API |
| GET | `/api/auth/providers` | Métodos disponíveis |
| POST | `/api/auth/register` | `{ "email": "...", "password": "..." }` |
| POST | `/api/auth/login` | `{ "email": "...", "password": "..." }` |
| GET | `/api/auth/me` | Usuário da sessão; 401 sem sessão |
| POST | `/api/auth/logout` | Revoga a sessão atual |
| POST | `/api/auth/google/start` | 503, reservado para configuração posterior |
| POST | `/api/auth/phone/start` | 503, reservado para configuração posterior |

## Nível geral e experiência do perfil

`POST /api/progression/sync` reconhece o histórico da sessão no MongoDB;
`GET /api/progression` consulta o estado persistido sem sincronizar. Ambos exigem
sessão e retornam nível, XP total, progresso no nível, divisão por atividade e
até 20 atividades creditadas recentemente. O POST também exige a origem autorizada.

Regras iniciais: filme 20 XP, episódio regular 5, livro concluído 50, jogo
concluído 50, hora inteira jogada 2 (primeiras 100 horas por jogo), avaliação com
nota ou sentimento 3 e conquista já concedida 25. Datas desconhecidas e itens
arquivados contam; adicionar uma intenção de consumo não pontua. Avaliações de
obras exigem conclusão; avaliações de episódios exigem marcação assistida.

O nível 1 começa com zero XP; chegar ao nível 2 exige 100 XP, depois cada novo
avanço exige mais 25 XP. O nível geral não interfere nos níveis das conquistas.
Créditos de `user_xp_credits` usam identidade estável de obra/episódio/conquista,
com maior quantidade de horas reconhecida. Editar, desmarcar, excluir ou
recadastrar a mesma identidade não duplica nem remove XP reconhecido. Os
carimbos de data indicam reconhecimento no XP, inclusive para importações
retroativas, e não inventam datas de consumo. A origem do XP é privada.

Validação isolada: `node --test test/progression.test.cjs` após o build.

## Notificações no aplicativo

`user_notifications` guarda eventos privados de conquistas e convites recebidos,
com índice único por dono, tipo e origem. `GET /api/notifications` retorna até 30
eventos, `unreadCount` global e `nextCursor` para a próxima página. A consulta
recupera conquistas anteriores e convites pendentes, sem marcar leitura.

`PATCH /api/notifications/:id/read` e `POST /api/notifications/read-all` salvam a
leitura no MongoDB, exigem sessão e origem autorizada e retornam 204. A leitura é
independente da confirmação de celebrações. Convites aceitos ou encerrados
permanecem no histórico, com status atual consultado no servidor. O cliente usa
os endpoints de amizades existentes para aceitar ou recusar; atualiza o contador
a cada 30 segundos enquanto visível e após ações locais. Não usa push externo.

Validação isolada: `node --test test/notifications.test.cjs` após o build.

## Autenticação

### Confirmação de e-mail no cadastro

Novas contas exigem confirmação antes de fazer login, usando as mesmas variáveis
SMTP do Gmail já configuradas. `EMAIL_VERIFICATION_REQUIRED=true` é o padrão;
`false` permite cadastro direto para ambientes que explicitamente dispensam a
confirmação. Contas antigas sem o marcador de obrigatoriedade mantêm seu acesso;
elas não são marcadas como verificadas automaticamente.

`POST /api/auth/register` retorna `requiresVerification: true`, sem cookie de
sessão, e envia o e-mail com o layout da recuperação. O frontend mostra a tela
de instruções e permite reenviar. O link `#verify-email=...` vale por 24 horas;
apenas o hash é salvo no MongoDB. Abrir o link não o consome: o usuário clica em
**Confirmar meu e-mail**, que chama `POST /api/auth/confirm-email` com `{ token }`.
Após confirmar, é necessário fazer login com a senha cadastrada.

`POST /api/auth/resend-confirmation` recebe `{ email }`, mantém resposta genérica
e limita o envio a uma vez por minuto por conta. Reenvios invalidam o link
anterior. As rotas têm limite de cinco chamadas por minuto por IP e exigem a
origem configurada. Falhas SMTP mantêm a conta pendente e permitem reenviar depois.
Para contas novas verificadas, trocar o e-mail no perfil exige confirmar o novo
endereço e encerra as sessões. Recuperar a senha não confirma o e-mail.

Teste isolado, com SMTP simulado: `node --test test/email-confirmation.test.cjs`.

### Recuperação de senha com Gmail SMTP

No `server/.env`, configure:

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=seuemail@gmail.com
SMTP_PASS=senha_de_app_google_sem_espacos
CLIENT_ORIGIN=http://localhost:5174
```

Ative a verificação em duas etapas da conta Google e gere uma senha de app em
https://myaccount.google.com/apppasswords (nome sugerido: NextPlay). Use os 16
caracteres sem os espaços de apresentação; não use a senha normal do Gmail.
Contas de organizações ou com Proteção Avançada podem não permitir senhas de app.
Reinicie o backend depois de editar o `.env`. O remetente usa `SMTP_USER`.
Porta 587 exige STARTTLS; 465 usa TLS desde a conexão. Credenciais nunca vão para
variáveis `VITE_*`. A integração respeita os limites de envio da conta Gmail.

Na tela de login, clique em **Esqueci minha senha**. O link enviado aponta para
`CLIENT_ORIGIN`, vale por 15 minutos e só pode ser usado uma vez. Em produção,
essa origem precisa ser o endereço HTTPS público do frontend. Em localhost,
abra o e-mail no mesmo computador que executa o frontend.

`POST /api/auth/forgot-password` recebe `{ "email": "..." }` e responde de forma
genérica, sem revelar contas cadastradas. Há limite de 5 chamadas por minuto
por IP/rota e intervalo mínimo de um minuto entre envios por conta.
`POST /api/auth/reset-password` recebe `{ "token": "...", "password": "..." }`.
A senha exige 12–128 caracteres. Apenas o hash do token é salvo no usuário;
o link usa fragmento e é removido da barra ao abrir a tela. A redefinição revoga
as sessões anteriores. Trocar o e-mail da conta invalida links anteriores.

Falhas de envio registram um aviso genérico no console e invalidam o token
não entregue, preservando a mesma resposta pública. Testes usam SMTP simulado:
`node --test test/password-recovery.test.cjs`. O envio real deve ser validado
após configurar as credenciais; nenhum e-mail real é enviado pelos testes.

Senhas de cadastro têm entre 12 e 128 caracteres e são armazenadas com scrypt e salt individual. A senha e os hashes não são retornados. Sessões usam tokens aleatórios de 256 bits em cookie HttpOnly/SameSite=Lax, com validade absoluta de 7 dias. O MongoDB armazena apenas o hash do token. Login renova a sessão do navegador e logout a revoga. A expiração é verificada em cada consulta, independentemente da limpeza TTL do MongoDB.

Requisições de alteração exigem `Origin` igual a `CLIENT_ORIGIN`. Tentativas são limitadas em janelas de um minuto no MongoDB: 5 cadastros e 20 chamadas às demais rotas por endereço/rota. O endereço de proxies não é confiado automaticamente. E-mails são únicos e normalizados. Novas contas confirmam o e-mail pelo Gmail SMTP antes do login. Recuperação de senha usa o mesmo SMTP, conforme a configuração acima.

Google e SMS estão deliberadamente indisponíveis. Nenhuma chave é necessária nesta etapa; as integrações reais serão adicionadas depois.

## Testes

`npm test` compila e testa contra o MongoDB local em um banco novo `nextplay_test_<uuid>`. Apenas esse banco temporário é removido ao concluir. A suíte cobre cadastro, validação, login, cookie, expiração, rotação, logout, limite de tentativas e serviços indisponíveis. Nunca aponta para o banco do app.

## Publicação futura

O deploy via SSM publica o MVP na EC2 com PM2/Nginx. O environment `production`
mantém `APP_ENV_FILE` com a configuração principal. `GOOGLE_BOOKS_API_KEY` pode
ser cadastrado como secret separado nesse environment: o runner incorpora a chave
ao `.env` privado sem imprimir seu valor nem incluí-lo no artifact público.
Se o secret dedicado não existir, a configuração presente em `APP_ENV_FILE` é mantida.
Os templates Nginx aceitam até 650 KB no transporte da API para as fotos de objetos;
o backend mantém os limites menores nas rotas que não recebem imagens.

## Fotos de perfil no S3

Novas fotos são enviadas pelo backend ao bucket privado `nextplay-ij`, em
`uploads/avatars/<userId>/<uuid>.jpg`. Configure `AWS_REGION` com a região real
do bucket e, opcionalmente, `S3_BUCKET` (padrão: `nextplay-ij`). O SDK usa a
cadeia padrão de credenciais: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
(e `AWS_SESSION_TOKEN` para credenciais temporárias), perfil local ou IAM role.
Mantenha essas variáveis somente no servidor e reinicie a API após alterá-las.

A identidade da API precisa de `s3:PutObject`, `s3:GetObject` e `s3:DeleteObject`
em `arn:aws:s3:::nextplay-ij/uploads/*`. Mantenha Block Public Access ativado
e ACLs desativadas. Não é necessário configurar CORS para esse fluxo, pois o
upload passa pela API e a leitura é feita como imagem por URL assinada.
Os uploads usam criptografia SSE-S3 e não definem ACL pública.

O MongoDB armazena `avatarKey`, sem URL assinada ou imagem nova em base64.
`GET /api/auth/avatar` exige sessão e redireciona para uma URL assinada de cinco
minutos. O frontend usa esse endereço estável para solicitar uma assinatura
nova sempre que a foto é carregada. Fotos antigas em base64 continuam legíveis
e são substituídas ao enviar uma nova foto. Omitir `avatar` ao atualizar o perfil
preserva a foto; enviar uma string vazia remove a foto.

O arquivo anterior só é excluído depois de salvar o perfil. Se o MongoDB rejeitar
a alteração, o arquivo novo é removido. Falhas de limpeza são registradas sem
expor credenciais; podem deixar arquivos órfãos para limpeza posterior.
Com versionamento S3, DeleteObject cria um marcador de exclusão: configure
lifecycle para versões antigas se precisar removê-las definitivamente.

Validação: `npm run build` e, com MongoDB local ativo,
`node --test test/profile.test.cjs`. O teste usa um banco temporário e substitui
o S3 por um stub, sem acessar o bucket real.

## Publicação

O frontend hospedado não se conecta à API local. Ao publicar, use HTTPS e proxy de mesma origem para `/api`, defina `NODE_ENV=production`, `CLIENT_ORIGIN` e `MONGODB_URI`. Em produção o cookie é Secure e o cadastro fica desativado por padrão; habilite apenas quando desejado usando `ALLOW_REGISTRATION=true`. Configure acesso autenticado ao MongoDB e mantenha segredos fora do Git.

Referências: [NestJS + MongoDB](https://docs.nestjs.com/techniques/mongodb), [cookies no NestJS](https://docs.nestjs.com/techniques/cookies).

## Deploy e versionamento

Consulte [DEPLOY.md](DEPLOY.md) para GitHub Actions, SSM, PM2, Nginx, portas, HTTPS e recuperação de versões.

## Otimização de leituras autenticadas (local)

`AuthService.forRequest` compartilha a validação da sessão entre dono e idioma dentro da mesma requisição HTTP. A listagem e as ações da biblioteca deixam de repetir as consultas de sessão/usuário no MongoDB. O cache usa a identidade do objeto da requisição e não é compartilhado entre requisições; logout, revogação e alterações de idioma continuam sendo verificados em cada novo acesso. Nenhum contrato de endpoint ou DTO foi alterado. Testes unitário e HTTP com banco descartável cobrem isolamento e revogação.

Os templates Nginx deste repositório e do client também preparam gzip para os assets públicos do frontend; a configuração só será aplicada em um próximo deploy. Alterações locais, sem commit/push.

## Conquistas (implementação local)

As rotas autenticadas `GET /api/achievements`, `POST /api/achievements/sync`, `PATCH /api/achievements/title` e `POST /api/achievements/celebrations` estão documentadas no Swagger com DTOs de entrada/saída. Mutações exigem a origem do frontend. O servidor calcula as metas, valida o título escolhido e isola os dados por dono; não aceita pontos nem contagens enviados pelo navegador.

São 11 famílias/54 metas: Primeiro play; Só mais um episódio (5–100, de 5 em 5); Temporada encerrada (1/5/10/25); Cinéfilo (10/25/50/100); Devorador de páginas (5/10/25/50); Colecionador (10/25/50/100); Até o último episódio (1/5/10/25 séries explicitamente concluídas); Universo em episódios (25/100/250/500 regulares distintos, incluindo legado/lotes); De volta aos clássicos (5/10/25/50 filmes anteriores a 2000); Na cadeira do crítico (5/10/25/50 filmes assistidos com nota de 1 a 5); Hoje tem final (uma temporada completa no mesmo dia, só marcações individuais, sem episódios futuros). Cada meta retorna `level` e `levels` para representar estrelas sem depender da posição no array. `achievement_awards` mantém desbloqueios/celebrações, com índice único por dono/ID; `achievement_profiles` mantém título/fuso. Concessões usam lote idempotente e leituras locais, sem consultas a provedores externos. Remover obras não revoga medalhas concedidas.

O progresso de episódios novo recebe `watchOrigin=individual` somente na primeira marcação individual; lotes/conclusões recebem `bulk`. Reavaliações preservam a origem/data. O legado sem origem não qualifica maratonas. Episódios distintos são agrupados por dia civil no fuso IANA validado. Especiais são excluídos; temporadas precisam estar importadas integralmente, sem episódio futuro. Posse e consumo são contagens separadas. Filme/livro concluído e posse atuais podem gerar conquistas retroativas na sincronização.

`test/achievements.test.cjs` usa banco local descartável e cobre regras de data/fuso, concorrência, autenticação/Origin, isolamento entre donos, títulos bloqueados, confirmação de celebrações, progresso legado/em lote, persistência após exclusões e os schemas do Swagger. Nenhuma configuração extra de ambiente é necessária. Trabalho local sem commit/push/deploy.
