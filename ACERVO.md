# Acervo do colecionador

O acervo registra posse; o acompanhamento registra consumo. Os dados ficam
separados: `collector_copies` não grava em `library_items` nem `episode_progress`.
Não existe importação automática dos títulos acompanhados para o acervo.

Cada documento é um exemplar, com ID próprio, título, categoria, formato físico
ou digital, plataforma/suporte, edição e observações privadas. A mesma obra pode
ter várias cópias, inclusive com a mesma edição e plataforma. Livros permitem
busca no Google Books ou cadastro manual, sem habilitar acompanhamento de leitura.

## Livros — Google Books

No backend, configure `GOOGLE_BOOKS_API_KEY` no `.env` após habilitar a Books API
no Google Cloud. Restrinja a chave à Books API e nunca use uma variável `VITE_*`.
Quando houver publicação, incluir essa linha também no secret `APP_ENV_FILE` do
environment de produção. Nenhuma chave é necessária no frontend.

`GET /api/catalog/books/search?q=Dom%20Casmurro&field=title&page=1`
aceita `field=title|author|isbn`, termo de 2–100 caracteres e páginas de 1–50,
com 20 resultados por página. Exige sessão. O ISBN aceita hífens e espaços,
valida o dígito verificador e filtra a edição exata (ISBN-10/13 equivalentes).
Ao abrir Livros, `GET /api/catalog/books/suggestions?page=1` usa somente os livros
do acervo do usuário autenticado. A prioridade é estrita: afinidade textual de
título, depois mesmo autor e depois editora. Gêneros servem como desempate ou
último recurso. Compartilhar palavras significativas do título é uma heurística,
não uma identificação oficial de série/franquia. Variações de pontuação, ordem e
iniciais do autor são normalizadas (George R. R. Martin / George Martin).

São consultados título e autor, além da editora como fonte alternativa. Quando há
resultados relacionados ao título/autor, a lista não é completada com obras que
só compartilham editora/gênero. Assim, uma editora grande não domina a lista.
Quantidade de exemplares ou frequência da editora não ultrapassa a prioridade de
título/autor. O idioma salvo no perfil (pt-BR, en-US ou es-ES) define as edições
elegíveis nas sugestões gerais e personalizadas, tanto na coleção quanto no
Explorar. A consulta usa langRestrict e confere o idioma de cada edição: outros
idiomas e idioma ausente são excluídos. O idioma dos livros já salvos não altera
essa escolha. São usados os títulos reais da edição, sem traduzir artificialmente
um volume de outro idioma ou trocar seu ISBN. Cópias/edições repetidas não
dão votos extras, e referências/ISBNs/título-autoria já possuídos são excluídos.
Empates de frequência respeitam a ordem mais recente dos livros do acervo.
O cache compartilhado guarda apenas candidatos públicos por consulta; as
preferências, exclusões e ordenação são calculadas por usuário a cada acesso.
Adicionar ou remover livros muda as sugestões sem esperar o cache expirar.

### Livros no Explorar

`GET /api/library/explore` inclui livros do Google Books sem filtro ou em
`kind=book`. Na interface, Explorar abre em Filmes e oferece somente as abas
Filmes, Séries, Jogos e Livros, sem Todos. A personalização usa somente o acompanhamento de leitura da
sessão (`context=reading`), mantendo exemplares possuídos separados. A ordem por
título, autor e editora é preservada na interface; títulos já acompanhados são
excluídos. Sem preferências, há sugestões gerais no idioma do perfil. As seções são
consultadas em paralelo, e uma falha externa marca apenas a respectiva seção
como indisponível. A paginação de livros vai até 50 e usa `nextPage`; os botões
adicionam ao acompanhamento em Quero ler, sem criar cópias na Minha Coleção.

### Prévia e conclusão no Explorar

A capa e o nome de um título abrem uma prévia sem gravar acompanhamento ou
posse. Filmes, séries e jogos carregam metadados públicos em
`GET /api/catalog/details?catalogId=...`, no idioma da sessão; livros e títulos
locais usam os dados já carregados. Filmes e séries TMDB também oferecem
`GET /api/catalog/trailer?catalogId=...`, com fallback para inglês e somente
chaves YouTube validadas. A falha do vídeo não bloqueia os detalhes ou o cadastro.

Filmes têm a ação Adicionar como assistido no card e na prévia. A confirmação
permite escolher data, estrelas e sentimento; o POST já salva `status=completed`,
sem criar primeiro um registro planejado. Antes de salvar, a interface confere
a lista atual: um filme planejado por outra aba é atualizado preservando suas
anotações; uma conclusão existente não é sobrescrita. Cancelar não grava nada.
No Explorar, adicionar ou concluir mantém a tela, o filtro e os cards nas mesmas
posições; só as ações mudam para Adicionado/Assistido. Filmes/séries consultam
`totalPages` do catálogo filtrado (até 500 páginas TMDB) e sorteiam páginas
distintas de todo esse intervalo. A página 1 serve para conhecer o total, sem
ser obrigatoriamente exibida. O histórico de páginas consultadas permanece no
sessionStorage por categoria, idioma e preferências; a visita seguinte e o
botão Novas sugestões evitam essas páginas até esgotar o ciclo. A rolagem
continua a ordem sorteada usando um cursor por posição, inclusive quando a
próxima página real é numericamente menor. Páginas que falham preservam o cursor
e não são marcadas como visitadas. Apenas a categoria ativa é consultada. O cache
do provedor é preservado. Livros
mantêm a prioridade de título/autor/editora. Ver mais sugestões acrescenta
lotes da reserva local antes de consultar novas páginas, sem reordenar os
cards existentes; cada clique consulta no máximo três páginas externas.
Ao alcançar o final de uma lista visível, o Explorar carrega o próximo lote
automaticamente, usando IntersectionObserver e o loading compacto do app. Só
um lote é carregado por vez; modais abertos pausam o disparo. Falhas e lotes
sem novidades com cursor restante suspendem a continuação automática daquela
categoria, preservando cards/cursor e oferecendo tentativa manual. Quando o
catálogo termina, o observador deixa de acompanhar aquela lista.
A quantidade de cards considera as colunas reais da grade: por exemplo, 12
títulos em cinco colunas recebem mais três. A primeira carga, os próximos
lotes e o redimensionamento completam a última fileira, usando primeiro a
reserva local e depois novas páginas. Títulos já exibidos mantêm a ordem.
Falhas/cota e o fim do catálogo mantêm os resultados reais disponíveis; não há
duplicação nem cards fictícios para completar uma fileira sem candidatos.

Quando faltam metadados, são recuperados até dois volumes antigos por acesso,
com timeout de 6 segundos em paralelo e atualização restrita ao dono/volume.
Isso só acrescenta gêneros/editora e um marcador interno: não altera edição,
notas ou datas do exemplar nem o acompanhamento. Falhas nessa recuperação não
impedem o uso dos metadados já salvos. Livros manuais sem referência não recebem
gêneros ou editora inferidos.

Sem preferências disponíveis ou candidatos relacionados, a rota retorna uma
seleção geral no idioma do perfil (literatura brasileira para português e
literatura em inglês/espanhol), ainda excluindo posse. O cache público é
separado por idioma para que mudar a preferência não reutilize outra língua.
`personalized=true|false` informa qual modo foi usado; a interface diferencia os
dois. Falha em uma fonte de candidatos permite usar a outra; falha em todas
continua como erro explícito. As consultas relacionadas têm timeout de 8 segundos.

A tela consulta título/autor após uma pausa
de 500 ms e pelo menos dois caracteres. ISBN automático exige número completo e
dígito válido; o botão Buscar continua permitindo envio explícito. Alterar o termo
cancela o timer e a resposta anterior; limpar o campo volta às sugestões iniciais.
A rota de sugestões usa sessão, paginação e o mesmo limite/cache da busca.
As edições permanecem separadas por `googlebooks:book:<volumeId>`.

Autores, gêneros, editora, idioma, ISBN, ano e capa são resolvidos no servidor ao salvar a
referência. Esses campos não são aceitos do cliente. Cada cópia mantém ID próprio;
editar uma cópia já vinculada preserva os metadados sem consultar o provedor.
O cadastro manual sem referência continua funcionando sem chave ou com cota esgotada.
A interface identifica o Google Books e fornece links para seus volumes.

O serviço usa timeout de 12 segundos, cache em memória de 15 minutos (até 200
entradas), deduplicação de chamadas simultâneas e limite de 30 buscas/minuto por
usuário/processo. Erros não são armazenados como resultados vazios. Após 429 do
Google, novas chamadas são suspensas por um minuto; o cadastro manual permanece
disponível. Não se registra a chave nem a mensagem bruta do provedor.

Validação real (requer chave; não faz gravações no MongoDB):
`npm run build` e `node --env-file=.env scripts/validate-google-books.cjs`.
O roteiro consulta Dom Casmurro, A hora da estrela, Clarice Lispector e o ISBN
9788582850350, confirmado pela editora. A suíte offline usa fixtures sintéticas;
sucesso nessas fixtures não comprova cobertura real do Google.

## API

- `GET /api/collector/copies`: listar o acervo da sessão.
- `POST /api/collector/copies`: cadastrar outro exemplar.
- `PATCH /api/collector/copies/:id`: substituir os dados editáveis desse exemplar.
- `DELETE /api/collector/copies/:id`: remover somente o exemplar identificado.

POST/PATCH exigem `title`, `kind` e `format`. Campos opcionais omitidos ficam
vazios. `catalogId` pode apontar para filme/série TMDB ou jogo IGDB; os metadados
são resolvidos no servidor e a categoria precisa corresponder à referência.
Livros também aceitam `googlebooks:book:<volumeId>`.
Quando a referência permanece igual, editar a cópia dispensa uma consulta externa.

As rotas usam a sessão HttpOnly existente. Mutações exigem `Origin` igual a
`CLIENT_ORIGIN`. Todas as consultas e alterações incluem o usuário autenticado;
IDs de cópias de outro usuário retornam 404.

Swagger: `/api/docs` e `/api/docs-json`, quando `SWAGGER_ENABLED=true`.
Na EC2, manter a habilitação explícita de produção já documentada no deploy.

## Acompanhamento de leitura

Livros também podem ser registrados em `/api/library`, com `kind=book` e os
estados `planned` (Quero ler), `active` (Lendo) e `completed` (Lido). São aceitos
cadastro manual e referência `googlebooks:book:<volumeId>`; metadados do catálogo
são resolvidos pelo servidor. Data de leitura e avaliação seguem as regras de
conclusão existentes. Voltar a um estado pendente limpa os dados de conclusão.

Adicionar ou concluir uma leitura não cria exemplares; cadastrar ou excluir um
exemplar não muda o acompanhamento. Cada lista mantém o isolamento por usuário.
`GET /api/catalog/books/suggestions?context=reading` considera apenas os livros
acompanhados; `context=collection` (padrão) considera os exemplares possuídos.
As estatísticas gerais incluem o contador de livros lidos.

Nos cards de livros de Minha Coleção há atalhos Quero ler/Lendo/Lido. O frontend
usa as rotas existentes de biblioteca, reutiliza a leitura da mesma referência
de catálogo (ou do mesmo título manual), preserva as anotações de leitura e
permanece na coleção. Notas do exemplar não são copiadas para a leitura.
Os atalhos pedem somente confirmação Sim/Não, com o estado já escolhido. Uma
nova conclusão usa a data atual; repetir Lido preserva a data e a avaliação
existentes. Data/avaliação continuam editáveis no acompanhamento da biblioteca.
Nenhum exemplar é alterado.

## Validação

### Objetos na aba Outros

`kind=other` representa objetos físicos cadastrados manualmente. `title` e
`category` (até 60 caracteres) são obrigatórios; foto e observações são opcionais.
Não aceita referência de catálogo e não grava acompanhamento nem episódios.
Categorias como Carrinhos e Action figures são livres e podem ser filtradas na aba.

O campo `photo` recebe JPEG data URL de até 600000 caracteres. O navegador aceita
JPG/PNG/WebP até 10 MB, reduz para 1024 px no maior lado e converte para JPEG sem
recortar o objeto. Omitir `photo` preserva a foto ao editar; `photo=""` remove.
Fotos não são reaproveitadas automaticamente ao criar outra cópia.

O S3 usa `uploads/collector/<userId>/<uuid>.jpg` no bucket `S3_BUCKET` (padrão
`nextplay-ij`), SSE-S3 e acesso privado. A identidade AWS existente precisa de
PutObject/GetObject/DeleteObject nesse prefixo; a permissão documentada em
`uploads/*` já o inclui. Não é necessário tornar o bucket público.

`GET /api/collector/copies/:id/photo` autentica a sessão, verifica o dono e responde
302 para URL assinada de cinco minutos. A listagem retorna somente a rota privada
de foto, nunca a chave S3 ou o base64. Falhas de upload não salvam o exemplar;
falhas de persistência removem o upload novo. Troca, exclusão ou remoção da foto
limpam o arquivo anterior após sucesso no banco. Edições concorrentes retornam 409.

`test/collector-objects.test.cjs` cobre CRUD, isolamento, foto privada, validação,
rollback e independência da biblioteca usando banco descartável e S3 simulado.
`node --env-file=.env scripts/validate-collector-photo.cjs` testa o prefixo S3 real
com objeto temporário removido ao final, sem alterar exemplares.

`npm test` inclui o teste de integração `test/collector.test.cjs`, com banco
MongoDB local descartável, cópias repetidas, isolamento entre usuários, validação
dos DTOs, contrato Swagger e preservação do acompanhamento.
`test/book-reading.test.cjs` valida leitura manual/Google Books, transições de
estado, preservação dos metadados, privacidade e independência dos exemplares.
