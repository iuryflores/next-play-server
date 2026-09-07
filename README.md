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

## Autenticação

Senhas de cadastro têm entre 12 e 128 caracteres e são armazenadas com scrypt e salt individual. A senha e os hashes não são retornados. Sessões usam tokens aleatórios de 256 bits em cookie HttpOnly/SameSite=Lax, com validade absoluta de 7 dias. O MongoDB armazena apenas o hash do token. Login renova a sessão do navegador e logout a revoga. A expiração é verificada em cada consulta, independentemente da limpeza TTL do MongoDB.

Requisições de alteração exigem `Origin` igual a `CLIENT_ORIGIN`. Tentativas são limitadas em janelas de um minuto no MongoDB: 5 cadastros e 20 chamadas às demais rotas por endereço/rota. O endereço de proxies não é confiado automaticamente. E-mails são únicos e normalizados. Cadastro não confirma a posse do e-mail; verificação de e-mail e recuperação de senha ainda não estão implementadas.

Google e SMS estão deliberadamente indisponíveis. Nenhuma chave é necessária nesta etapa; as integrações reais serão adicionadas depois.

## Testes

`npm test` compila e testa contra o MongoDB local em um banco novo `nextplay_test_<uuid>`. Apenas esse banco temporário é removido ao concluir. A suíte cobre cadastro, validação, login, cookie, expiração, rotação, logout, limite de tentativas e serviços indisponíveis. Nunca aponta para o banco do app.

## Publicação futura

O frontend hospedado não se conecta à API local. Ao publicar, use HTTPS e proxy de mesma origem para `/api`, defina `NODE_ENV=production`, `CLIENT_ORIGIN` e `MONGODB_URI`. Em produção o cookie é Secure e o cadastro fica desativado por padrão; habilite apenas quando desejado usando `ALLOW_REGISTRATION=true`. Configure acesso autenticado ao MongoDB e mantenha segredos fora do Git.

Referências: [NestJS + MongoDB](https://docs.nestjs.com/techniques/mongodb), [cookies no NestJS](https://docs.nestjs.com/techniques/cookies).
