# Planejamento e importação de jogos

Entrega local S191/S192/S196/S197, sem deploy automático nesta etapa.

## Planejar meus jogos

Na visão geral → Jogos (e nas listas Para depois/Em andamento), abrir **Planejar meus jogos** e calcular. A consulta privada pagina vinte jogos por vez, quatro consultas IGDB simultâneas; reutiliza o cache público de estimativas. Não dispara chamadas para toda a biblioteca ao abrir a página.

O total reúne jogos planejados/em andamento não arquivados, usando média IGDB do objetivo escolhido menos horas da própria parte. DLCs acompanhadas são partes independentes para o cálculo: não se reutiliza o total agregado do card do principal. Ausências e erros são exibidos como cobertura incompleta, nunca como jogos com zero horas de duração. É uma estimativa, não um prazo garantido; alcançar a média não conclui o título.

A seleção do próximo jogo é determinística, a partir do backlog: prioridade, andamento, menor restante, nome e ID. Filtra plataforma, gênero e orçamento de horas **para terminar**, que não é duração de sessão. Com orçamento, exclui jogos sem estimativa e médias já ultrapassadas; sem orçamento permite mostrar estes casos com rótulo explícito. Exclui lançamentos futuros/não anunciados. Não usa IA ou sorteio.

Esta entrega cobre jogos. Estimativas/recomendações de filmes, séries e livros dentro do backlog continuam fora deste escopo; S191/S192 permanecem parciais no escopo universal original.

## Importar jogos e histórico

Na visão geral → Jogos, abrir **Importar jogos e histórico**.

- Steam: botão **Conectar Steam** redireciona ao login oficial OpenID; vincula a identidade Steam confirmada à conta NextPlay já autenticada. O ID não precisa ser digitado. Retorna à biblioteca/Jogos e abre o painel de importação. **Consultar minha biblioteca Steam** usa o ID do vínculo no servidor e abre prévia; importar continua exigindo confirmação. Detalhes de jogos precisam estar públicos. Não recebe senha ou chave do usuário. O endpoint manual antigo permanece compatível, mas não é o caminho da interface.
- Requer `STEAM_WEB_API_KEY` configurada no ambiente do **servidor**. Gerar em https://steamcommunity.com/dev/apikey e incluir em `.env` local e, quando houver autorização para publicar, em `APP_ENV_FILE` no ambiente GitHub production. Nunca colocar em `VITE_*`, frontend, planilha ou mensagem de chat. Sem a chave a UI explica a indisponibilidade, e o endpoint retorna 503. O usuário configurou a chave localmente; esta entrega não altera secrets GitHub nem acessa contas Steam reais nos testes. O CLIENT_ORIGIN precisa ser o endereço do frontend de cada ambiente: localhost no desenvolvimento, domínio HTTPS em produção, sem /api.
- Arquivo JSON interoperável aceita `steam`, `xbox`, `playstation`, `epic`, `gog`, `nintendo`. Até 200 jogos/100 KiB por arquivo; exemplo em `client/public/data/game-import-example.json`. Requer adaptação ao modelo; não é um parser nativo de exportações de cada fornecedor. Não significa conexão automática com essas contas.
- Prévia privada por uma hora, paginação de vinte, confirmação por jogo ou lote de até vinte jogos revisados. Falhas de lote preservam confirmações anteriores e podem ser retomadas. Armazenamento temporário usa TTL; expiração também é verificada na leitura.
- Acervo e acompanhamento independentes: um cria cópia digital, o outro cria Para depois ou vincula a um jogo próprio explicitamente escolhido. Importação não infere conclusão, status Jogando, data de consumo, sessões, eventos sociais ou propriedade de DLCs.
- Reimportar a mesma origem não duplica cópias/acompanhamentos importados. Cópias criadas manualmente não são fundidas automaticamente; o usuário deve vincular o acompanhamento existente para evitar outra entrada.
- Horas da plataforma são totais: usa o maior valor entre atual e importado, sem somar totais; preserva sessões, avaliações, notas, plataforma e status. Não combina automaticamente horas independentes de várias plataformas. Controle de concorrência recusa alteração simultânea de horas e reserva destino único por origem.
- Conquistas externas: consulta opcional por jogo Steam, apenas contagens de desbloqueadas/total, ou contagens fornecidas no arquivo. Ausência/privacidade não vira zero. Aparecem nos detalhes em seção privada separada; não concedem conquistas NextPlay. Importar horas pode alimentar as regras existentes de XP de horas, sem criar XP específico de conquistas externas.
- Não há sincronização agendada, lista detalhada de troféus ou login/importação automática de Xbox/PSN/Epic/GOG/Nintendo. O login/vínculo Steam está implementado. S196/S197 permanecem parciais pelas demais plataformas e limites descritos.

## Fontes técnicas

- Steam biblioteca: https://partner.steamgames.com/doc/webapi/IPlayerService
- Steam conquistas: https://partner.steamgames.com/doc/webapi/ISteamUserStats
- Steam API/identidade: https://steamcommunity.com/dev
- Xbox: https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/live/rest/uri/titlehistory/atoc-reference-titlehistoryv2
- Epic Ecom tem escopo de propriedade de produtos do integrador, não promete biblioteca universal: https://dev.epicgames.com/docs/epic-games-store/services/ecom/ecom-overview

APIs oficiais utilizáveis para sincronização das outras plataformas ainda precisam ser avaliadas/habilitadas conforme acesso de desenvolvedor. Não usamos tokens de sessão copiados dos launchers, scraping ou endpoints privados como se fossem integrações oficiais.

## Validação

`client/tests/game-planner.test.mjs`: soma/cobertura/DLCs, ausência/falha, prioridade, filtros, orçamento e lançamentos. `server/test/game-imports-planner.test.cjs`: sessão/origem/dono, prévia e expiração, acervo separado de consumo, reenvio, preservação de sessões/avaliações/horas maiores e destinos de outras contas; Steam simulada, ausência de chave e resposta privada; paginação/cobertura privada do planejador. Nenhum perfil externo real é consultado nesses testes.

## Login Steam (complemento local)

Estado aleatório de 256 bits, somente hash no banco, expiração de dez minutos, uso único e vínculo à sessão NextPlay iniciadora. O callback aceita apenas emissor/identidade Steam esperados, return_to exato, campos obrigatórios assinados e nonce recente. Verificação direta check_authentication em host fixo com timeout, sem enviar a Web API Key. Nonces usados também ficam sob TTL e bloqueiam replay.

Cada tentativa incrementa a revisão do vínculo. Retornos antigos não substituem tentativas recentes; desconectar invalida callbacks que já estavam aguardando a Steam e consultas de biblioteca em andamento. Desconexão apaga estados/prévias e remove identidade vinculada, preservando os jogos e dados externos já confirmados. Cancelamento/erro não remove a conexão anterior.

`server/test/steam-connection.test.cjs` cobre transporte de verificação, sessão/origem, outra conta/outra sessão do mesmo dono, retorno inválido, assinatura falsa, expiração, cancelamento, repetição e callback concorrente com desconexão. Provedor simulado; o login real no navegador não foi realizado nesta entrega. Sem commit/push/deploy.

## Destino e origem da importação (complemento local)

Acompanhamento vem marcado por padrão; acervo digital é opcional e começa desmarcado. Novos acompanhamentos entram em Para depois e aparecem na Visão geral/Jogos com as horas importadas; horas não inferem estado Jogando. Registros importados anteriormente apenas no acervo não são movidos silenciosamente: reimportar com acompanhamento cria a entrada correspondente sem duplicar a cópia importada.

Cards do acompanhamento incluem a tag Importado da Steam, com link fixo para a loja do jogo, na pilha de tags sem sobreposição. Nos detalhes, os dados externos incluem link do jogo, conta de origem (link do perfil), horas da origem e data/hora da última importação. A conta é copiada da prévia consultada; conectar outra conta ou desconectar não reatribui importações antigas. Arquivos sem conta e registros antigos sem essa informação mostram origem não registrada e a orientação de reimportar, sem inferir a conta atualmente conectada.

O selo de importações antigas é reconhecido por consulta em lote em library, sem rede nem gravação de migração no GET. A conta de origem permanece privada ao dono e não é adicionada a perfis sociais/listas compartilhadas. Testes pertinentes da API verificam URLs, snapshot de origem, troca de conta atual e ausência de origem em legados; Steam simulada. Builds aprovados. Sem commit/push/deploy.

Atualização de localização da interface: a importação e conexão Steam ficam em Minha conta → Integrações → Importar jogos e histórico. O retorno OpenID agora abre /conta e o painel da integração. Planejar meus jogos permanece na visão geral. A biblioteca é atualizada após importar, sem sair de Minha conta. Sem commit/push/deploy.

## PSN experimental (complemento local)

Minha conta → Integrações → Contas conectadas → PlayStation Network · Experimental. Biblioteca comunitária `psn-api` fixada em 2.18.1. Não é login OAuth oficial da Sony: o próprio usuário faz login no site Sony, obtém seu NPSSO no mesmo navegador e informa o código no campo protegido do NextPlay, com consentimento explícito. O campo é limpo ao enviar; não usar chat para fornecer a credencial.

A API exige sessão NextPlay e mesma origem, valida formato e consentimento, troca o código no servidor e consulta exclusivamente `me`. Exige perfil próprio confirmado (`isMe`). NPSSO, código intermediário, ID token e refresh token não são persistidos nem retornados. Só o access token fica na memória do processo, vinculado ao hash da sessão NextPlay, pelo menor prazo entre validade retornada (menos margem) e uma hora. Remoção automática por timer; desconectar/reconectar invalida operações pendentes e limpa prévias. Reiniciar a API exige reconexão. Não há nova chave de ambiente ou credencial de usuário gravada no banco. A implantação atual usa processo único PM2 fork; múltiplas instâncias exigiriam uma estratégia de sessões antes de ativar este conector.

Consulta paginada do histórico de **jogos jogados**, não de toda a biblioteca de compras. Até dez mil registros, sem casar por nome. Duração ISO 8601 vira minutos inteiros sem inventar dados ausentes. Versões PS4/PS5 têm IDs e plataformas separados. A prévia mantém revisão/confirmar em lote, acompanhamento marcado e acervo opcional; o usuário só deve declarar posse quando de fato possuir o jogo. Não cria sessões ou datas antigas, status Jogando ou conclusão a partir de horas/troféus.

Consulta de troféus por jogo usa `npTitleId` exato e a mesma conta da prévia; deduplica `npCommunicationId`. São contagens desbloqueadas/total externas, sem lista detalhada ou conquista/XP específico no NextPlay. Falhas/ausência não apagam a contagem anterior nem são tratadas como zero. Detalhes mostram a conta de origem PSN da importação e fonte experimental, preservados após desconectar.

Cada chamada ao SDK tem limite lógico de 15 s; a paginação tem orçamento de 60 s e interrompe entre páginas quando o cliente fecha a resposta. Como o SDK não oferece AbortSignal, a requisição externa iniciada pode terminar depois do timeout, mas o retorno tardio não atualiza a conexão nem confirma importação. Erros são genéricos e não retornam payloads/autorização do fornecedor.

Testes: `server/test/psn-connection.test.cjs` cobre duração, autenticação/origem/consentimento, outra sessão/conta, paginação, ausência de horas, versões, troféus exatos sem duplicação, prévia, destino/plataforma, origem, expiração, desconexão concorrente e ausência de NPSSO/access token em todas as coleções. Gateway Sony simulado; nenhuma conta PSN real foi acessada. Builds aprovados; sem commit/push/deploy.

Referências do projeto comunitário: https://github.com/achievements-app/psn-api e https://psn-api.achievements.app/authentication/authenticating-manually . Mudanças da Sony podem quebrar esta integração; não há promessa de catálogo completo nem equivalência às integrações oficiais.
