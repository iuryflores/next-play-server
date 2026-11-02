# Comunicação, perfil e estatísticas

Implementação local de 02/11/2026. Não implica publicação em produção.

## Entradas da interface

- Amigos → Comunidade: discussões e teorias por obra, episódio, franquia ou universo; escolha em grupo, votação de favoritos, duelos e premiações anuais criadas pelos usuários.
- Amigos → Atividades / Meu perfil social: bio, gostos, até dez favoritos, atores/diretores/autores favoritos, descoberta de perfis e seguidores independentes de amizade.
- Detalhes de título → Compartilhar com amigos: link opaco, exige sessão e amizade aceita; não publica notas, progresso ou IDs privados da biblioteca.
- Estatísticas → Histórico, retrospectivas e comparação entre anos: linha do tempo de consumo, revisitas e sessões, retrospectivas, gêneros por ano, rankings anuais e gerais, criadores, franquias e comparação com a crítica.
- Amigos → Listas: colaboração por convite e aceite, entregue junto deste pacote.

## Regras

- Perfil privado, comparação de gostos e publicação para seguidores desativados por padrão. Compartilhar com amigos e com seguidores são escolhas diferentes.
- Seguir exige perfil publicado. Receber atividades exige autorização específica do autor. Novos compartilhamentos ou seguidores não recebem retroativamente atividades anteriores.
- Comparação de gosto exige amizade aceita e autorização das duas contas; retorna somente contagens e percentuais agregados.
- Publicações de comunidade são explícitas. Votações de grupo são para amigos aceitos do autor; as demais podem usar amigos ou usuários autenticados. Identificação de crítico é autodeclarada.
- Spoilers ficam protegidos por padrão. Há opção de texto comum e heurística conservadora de palavras; isso não equivale a classificação semântica infalível. Notificações não exibem trechos protegidos.
- Um voto por pessoa, substituível; resultados agregados. Voto e encerramento usam a mesma gravação atômica. Até 5.000 votos por votação. Premiações são organizadas pelos usuários, sem selo de prêmio oficial do app.
- Datas de consumo desconhecidas não viram datas de cadastro. Horas de jogos sem sessão datada aparecem sem data e ficam fora da retrospectiva anual.
- Notas dos rankings anuais são as avaliações atuais das obras consumidas naquele ano; não são um histórico de mudanças das notas.
- Créditos externos são atualizados em lotes pequenos, com cache e indicação de lacunas. Não há busca externa na leitura comum das estatísticas. Créditos/franquias manuais são privados, declarados e separados das identidades do catálogo.
- Franquias externas usam coleções de filmes TMDB; outras mídias podem ser agrupadas manualmente. Uma coleção TMDB não representa todos os universos narrativos possíveis.
- Comparação com crítica usa consultas inequívocas anteriores ao Rotten Tomatoes. Ausência/configuração indisponível não vira nota zero. Tomatometer mede aprovação, não uma nota de qualidade equivalente à escala pessoal.
- Registro privado de ações começa com esta versão e guarda retrato mínimo sem anotações. Não reconstrói alterações anteriores que nunca foram salvas. É separado do consumo e não concede XP.

## Limite ainda pendente

S142, relatório anual por IA, aguarda escolha e configuração do provedor. Não há requisições externas de IA, novas chaves ou custos de IA neste pacote. A retrospectiva S141 usa dados reais, sem texto gerado por IA.

## Validação

Suítes locais isolam MongoDB em bancos temporários. Cobrem aceite/revogação de colaboração, privacidade de seguidores e comparação, links de obras, votações, spoilers, conflitos, datas desconhecidas, sessões, revisitas, créditos manuais/externos e roteamento restaurável.
