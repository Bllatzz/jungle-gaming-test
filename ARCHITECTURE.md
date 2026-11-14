# ARCHITECTURE

Decisões, trade-offs e limitações do Distributed Wagering Processor.
Cada parte do desenvolvimento acrescenta suas seções aqui.

## Visão geral

Serviço NestJS que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas
por HTTP e por SQS, mantendo saldo materializado e ledger imutável consistentes sob entrega
at-least-once, mensagens fora de ordem e múltiplas instâncias.

Camadas (dependências só apontam para dentro):

- `src/domain` — regras de negócio em TypeScript puro. Não importa Nest, ORM nem AWS SDK.
- `src/application` — use cases e portas (interfaces).
- `src/infrastructure` — HTTP, SQS, persistência (MikroORM), observabilidade.

## Topologia

Um único app faz tudo (API HTTP, consumer SQS, worker da outbox, worker de pending-reference)
e roda em N réplicas idênticas.

- **Por quê:** uma imagem e uma config; "≥ 3 instâncias" são 3 processos iguais; todo worker
  precisa ser seguro sob concorrência desde o início.
- **Coordenação pelo banco, não por processo líder** *(planejado — partes 4 e 5)*: `SELECT … FOR UPDATE`
  por wallet e `FOR UPDATE SKIP LOCKED` nas filas de trabalho. O lock por wallet já foi provado no spike. Qualquer réplica pode morrer sem que nada pare.
- **Alternativas descartadas:** papéis por variável (`ROLE=api|worker`) — mais combinações para
  testar sem ganho no escopo do desafio; serviços separados — triplica setup em 48h.
- **Trade-off:** API e workers não escalam de forma independente.

## Stack e resultado do spike (Bun + NestJS + MikroORM)

Versões no momento do spike (as exatas ficam no `bun.lock`): Bun 1.3.13, NestJS 12.5, MikroORM 7.2,
TypeScript 7.0, PostgreSQL 16, LocalStack 4.12.

Spike executado antes de qualquer código de negócio:

| Verificação | Resultado |
|---|---|
| Nest sobe rodando com `bun` (decorators + metadata) | ✅ |
| `bun test` sobe o app Nest completo e consulta o banco | ✅ (testes de integração do health, via `createApp`) |
| Entidade mapeada com `EntitySchema` (sem decorators no domínio): persist/flush/find em `em.transactional()` | ✅ |
| `findOne` com `LockMode.PESSIMISTIC_WRITE` bloqueia uma 2ª transação até o commit da 1ª | ✅ (teste com duas transações reais) |
| Migrations `up`/`down` rodando com `bun` (sem Node) | ✅ após ajuste ↓ |
| App sobe com o Postgres fora do ar | ✅ MikroORM 7 só conecta sob demanda |
| LocalStack 4.12 sem auth token | ✅ |

**Ajuste necessário:** o MikroORM descobre arquivos de migration via `fs.glob({ withFileTypes })`,
que o Bun 1.3 não suporta. Solução: `migrationsList` explícito em
`src/infrastructure/persistence/migrations/index.ts`. Custo: ao criar uma migration, é preciso
registrá-la nesse arquivo.

**Migrations sem Node:** a CLI do MikroORM depende de Node; usamos um script próprio
(`src/infrastructure/persistence/migrate.ts`) que reutiliza a mesma config do app.

**Nada roda sob Node** — a imagem `oven/bun` não tem Node. `tsc` 7 é binário nativo.

## Filas

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | Entrada de transações. `VisibilityTimeout=30`, redrive para a DLQ após 5 recebimentos |
| `wager-transactions-dlq.fifo` | Mensagens com falha permanente ou que esgotaram as tentativas |
| `wallet-events.fifo` | Saída: destino dos eventos publicados pela outbox. O desafio pede publicação mas não define o destino; decisão nossa |

Deduplicação e ordenação do SQS FIFO são **otimização**. A garantia de não duplicar efeitos será
do banco — inbox persistente e constraints de unicidade (schema pronto; consumer na parte 5).
`MessageDeduplicationId` será sempre explícito (`messageId` na entrada, `eventId` na outbox).

`wallet-events.fifo` não tem DLQ: este serviço só publica nela. Quem consome os eventos define
a própria política de retry/DLQ.

## Health checks

- `GET /health/live` — o processo responde. Não olha dependências (senão o orquestrador mataria
  réplicas saudáveis durante uma queda do banco).
- `GET /health/ready` — `select 1` no Postgres **e** `GetQueueAttributes` nas 3 filas, em paralelo,
  com timeout de 2s cada. 200 ou 503 indicando quem caiu.
  - A URL da fila fica em cache, mas a checagem faz sempre uma chamada real ao SQS: com só o cache,
    uma queda do SQS passaria despercebida (coberto por teste).
  - A chamada ao SQS é cancelada por `AbortSignal` no timeout; no Postgres, `connectionTimeoutMillis`
    de 2s evita que tentativas penduradas virem conexões órfãs e esgotem o pool (medido: 3 sondas
    contra um Postgres pendurado deixavam 3 conexões abertas; agora 0).
- Trade-off aceito: com o SQS fora, a réplica sai do balanceamento inclusive para a API HTTP.
  É o que o desafio pede (readiness = Postgres **e** SQS alcançáveis).

## Autenticação

Não implementada (vale 0 pontos no desafio; prioridade foi correção financeira e concorrência).
Desenho que seria adotado:

- IdP externo (Keycloak) via OIDC, client-credentials por provedor de jogos.
- `AuthGuard` validando o JWT pela JWKS do IdP.
- O `providerId` do token é comparado ao `providerId` do payload — um provedor não submete
  transações em nome de outro.
- Ponto de extensão: guard no-op registrado nas rotas de negócio. Health checks e mensagens SQS
  (canal interno) ficam fora da autenticação, mas o `providerId` da mensagem segue validado.

## Domínio (`src/domain`)

TypeScript puro: nenhum import de Nest, ORM ou AWS SDK (há um teste que garante isso). Todas as
classes têm construtor privado e factories (`create`/`from`/`open` validam; `rehydrate` só reconstrói).

### Money
- `decimal.js` com precisão de 40 dígitos: somas e subtrações de valores com 2 casas nunca arredondam.
- Entrada (`Money.from`) aceita só `^(0|[1-9]\d{0,17})(\.\d{1,2})?$`: rejeita vazio, espaço, sinal,
  `NaN`, `Infinity`, notação científica, zero à esquerda, mais de 2 casas e mais de 18 dígitos
  inteiros (o limite cabe em `NUMERIC(20,2)`). `amount` precisa ser string: um `number` vindo do JSON é rejeitado.
- Internamente pode ficar negativo (ex.: diferença da reconciliação). Saída sempre com 2 casas.
- Moedas diferentes lançam `CurrencyMismatchError`. O modelo é multi-moeda; o desafio usa BRL.

### Wallet e ledger
- `debit`/`credit` validam e **devolvem o lançamento** criado: saldo e ledger nascem juntos.
- `version` começa em 1 e só incrementa quando o saldo muda (movimento de valor zero é rejeitado).
- `WalletLedgerEntry` é imutável de verdade: campos `readonly`, nenhum método de transição e
  `Object.freeze`. `create` valida `balanceBefore ± money === balanceAfter` e saldo final ≥ 0.
- Ledger de partida simples: um lançamento por transação por wallet. Partida dobrada é opcional
  no desafio e ficou fora pelo prazo.
- Abertura (`openWallet`): saldo inicial > 0 gera a transação interna `OPENING` (provider `internal`,
  idempotency key `internal:opening:{walletId}`) já `PROCESSED` e um `CREDIT` de 0 → saldo inicial.

### WagerTransaction
Segue o esqueleto do desafio. `OPENING` só nasce por `WagerTransaction.opening()`; `create` rejeita.
REFUND/ROLLBACK exigem `referenceExternalTransactionId`. Valor deve ser > 0 (LOSS aceita 0).

Transições (qualquer outra lança `InvalidTransactionStateError`):

```
PENDING           → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
PENDING_REFERENCE → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
PROCESSED, REJECTED, FAILED → terminais
```

### Regras (`applyWager`)
Uma função de domínio decide e aplica cada transação; o use case só carrega os dados e persiste.
Assim cada regra é testada sem banco. Antes de tudo, duas guardas de programação (lançam erro sem
tocar na wallet): transação já terminal e transação de outra wallet. Depois, a primeira checagem
que falha decide:

1. moeda da transação = moeda da wallet; player = dono da wallet;
2. se há referência:
   - o tipo não aceita referência (ex.: BET) ou a transação referencia a si mesma →
     `REFERENCE_INVALID_KIND` na hora (esperar não resolveria);
   - referência de outro provider/player/wallet/moeda/rodada → `REFERENCE_MISMATCH`, mesmo que ela
     ainda esteja pendente;
   - ausente ou ainda não aplicada → `PENDING_REFERENCE`;
   - senão precisa estar `PROCESSED`, ter tipo compatível (REFUND→BET; ROLLBACK→BET/WIN/REFUND;
     WIN e LOSS→BET), não ter sido revertida pelo mesmo tipo e ter o mesmo valor (REFUND/ROLLBACK).
     "Já revertida" vem antes de "valor errado" para o provedor receber o sinal de não reenviar;
3. LOSS → `PROCESSED` sem lançamento;
4. débito sem saldo → `INSUFFICIENT_FUNDS` (BET) ou `REVERSAL_INSUFFICIENT_FUNDS` (ROLLBACK);
5. aplica débito/crédito e marca `PROCESSED`.

Rejeição de negócio **não é exceção**: vira `failureCode` na transação. Exceções ficam para
violações de contrato e erros de programação.

### Códigos de falha

| Código | Quando | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | Não reenviar |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK deixaria o saldo negativo | Não reenviar; tratar como caso operacional |
| `CURRENCY_MISMATCH` | Moeda diferente da wallet | Corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | Player não é o dono da wallet | Corrigir o payload |
| `REFERENCE_NOT_FOUND` | Referência não chegou no prazo (parte 5) | Reenviar a referência ou desistir |
| `REFERENCE_NOT_PROCESSED` | Referência existe, mas foi rejeitada/falhou | Não reenviar |
| `REFERENCE_MISMATCH` | Referência de outro provider/player/wallet/moeda/rodada | Corrigir o payload |
| `REFERENCE_INVALID_KIND` | Tipo de referência não permitido | Corrigir o payload |
| `REFERENCE_ALREADY_REVERSED` | Já revertida pelo mesmo tipo | Não reenviar |
| `AMOUNT_MISMATCH` | Valor da reversão diferente da referência | Corrigir o payload |
| `INTERNAL_ERROR` | Falha permanente de infraestrutura (`FAILED`) | Contatar o suporte |

### Inbox, outbox e eventos
- `OutboxMessage.scheduleRetry`: backoff exponencial 1s, 2s, 4s… com teto de 5 minutos.
- Eventos: classe abstrata `IntegrationEvent` e uma subclasse por evento, com `eventType` e
  `version` no próprio tipo. `data` só carrega `MoneyProps` (strings), nunca `Money`.
- `aggregateId` é sempre o `walletId`: vira o `MessageGroupId` no SQS FIFO e mantém a ordem por wallet.
- Ids (`eventId`, ids de transação e de lançamento) são sempre passados de fora: o domínio é determinístico.
- Factories de evento e a outbox recusam estado errado (ex.: evento de rejeição para transação
  pendente, publicar duas vezes) em vez de gerar um contrato quebrado.
- Saldo que estouraria `NUMERIC(20,2)` é recusado no domínio, antes de chegar ao banco.

## Persistência (`src/infrastructure/persistence`)

### Mapeamento

O domínio não conhece o ORM. As tabelas são mapeadas como **linhas planas** (`defineEntity` em
`entities.ts`) e `mappers.ts` converte linha ↔ objeto de domínio, sempre lendo por `rehydrate`.
Mapear as classes de domínio direto brigaria com o construtor privado, os campos `_balance` e o
`Money` em duas colunas. Sobre as linhas o MikroORM continua dando Unit of Work,
`em.transactional()` e `LockMode` — que é o que a parte transacional usa.

**Money:** duas colunas, `amount NUMERIC(20,2)` + `currency CHAR(3)`. A propriedade é `decimal` em
modo `string`: o driver `pg` devolve `NUMERIC` como string e ela vai direto para `Money.from`, sem
nunca passar por `number`. 18 dígitos inteiros, mesmo limite do `Money.from` (testado no limite).

### Schema e garantias no banco

A migration é escrita à mão (`migrations/Migration20261114120000.ts`), porque o diff automático do
MikroORM não conhece `CHECK`, trigger nem índice parcial — e tentaria apagá-los. Por isso
`migration:create` gera sempre uma migration em branco. Enums viram `TEXT` + `CHECK` (trocar uma
lista é uma migration simples, sem `ALTER TYPE`).

| Garantia (§6) | Onde no banco |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets`; `balance_before/after >= 0` no ledger |
| Ledger imutável | trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE` |
| Lançamento coerente | `CHECK` da aritmética `before ± amount = after`; `amount > 0` |
| Lançamento na moeda da wallet | FK composta `(wallet_id, currency)` → `wallets (id, currency)` |
| Lançamento bate com a sua transação | FK composta `(transaction_id, wallet_id, amount, currency)` → `wager_transactions` |
| No máximo um lançamento por transação | `UNIQUE (transaction_id)` |
| Idempotência | `UNIQUE (provider_id, idempotency_key)` |
| Referência resolvida por provider + id externo | `UNIQUE (provider_id, external_transaction_id)` |
| REFUND/ROLLBACK exigem referência | `CHECK` |
| Regra 4 (uma reversão por tipo) | índice único parcial `(reference_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`, mais `CHECK` exigindo a referência resolvida (NULL escaparia do índice) e proibindo auto-referência |
| Transação é auditável | trigger: linha terminal não muda; nenhuma linha é apagada; campos do payload (os que entram no `payload_hash`) nunca mudam |
| Status coerente com os campos | `processed_at` ⇔ `PROCESSED`; `failure_code` ⇔ `REJECTED`/`FAILED` |
| Inbox deduplica | `PRIMARY KEY (consumer_name, message_id)` |
| Replay devolve o saldo daquele momento (regra 7) | `observed_balance` obrigatório em `PROCESSED`/`REJECTED` |

`wager_transactions` **não** tem FK de moeda nem de player com a wallet de propósito: uma transação
rejeitada por `CURRENCY_MISMATCH` ou `WALLET_PLAYER_MISMATCH` precisa ficar gravada para auditoria.

Índices além das constraints: `UNIQUE (wallet_id, wallet_version)` no ledger (histórico por
cursor, uma versão = um lançamento), parcial `WHERE status = 'PENDING_REFERENCE'` para achar quem espera uma referência,
parcial `WHERE published_at IS NULL` para o publisher da outbox.

Cada linha da tabela acima tem um teste em `test/integration/schema.test.ts` que tenta violá-la.
Os testes de integração rodam num banco próprio (`<banco>_test`, recriado a cada execução), nunca no
banco do dev — o ledger é append-only e não dá para limpar.

Os triggers levantam o erro padrão do PL/pgSQL (`P0001`), não `check_violation`: quebrar uma regra
de imutabilidade é erro de programação, e o app consegue diferenciar de um `CHECK` comum.

O que o banco **não** garante (fica no domínio): que a referência é da mesma wallet/provider/rodada
e do tipo certo, que só transação `PROCESSED` gera lançamento, e que `wallets.balance` é igual ao
último `balance_after` do ledger (o endpoint de reconciliação compara o saldo com a soma do ledger).

## Processamento de uma transação (`src/application`)

`ProcessWagerTransaction` é o único caminho de uma transação de aposta — a API usa hoje e o
consumer SQS vai usar o mesmo. Tudo numa transação SQL só, nesta ordem:

1. `SELECT … FOR UPDATE` na wallet (com `lock_timeout` de 5 s).
2. Idempotência: já existe transação com a mesma idempotency key ou o mesmo id externo do provider?
3. `applyWager` (domínio puro) decide.
4. Grava a transação → o lançamento → o saldo → os eventos na outbox.

### Concorrência: lock pessimista por wallet

A unidade de concorrência é a wallet, e o lock é na linha dela no Postgres. Isso dá:

- tudo da mesma wallet serializado (idempotência, resolução de referência, saldo) — sem lost update;
- wallets diferentes em paralelo (nada de lock global);
- correção com N instâncias, porque quem segura o lock é o banco, não o processo.

**Por que não optimistic locking:** numa hot wallet (muitas apostas disputando o mesmo saldo), o
optimistic faz quase todo mundo perder a corrida e tentar de novo. Com o lock pessimista cada
transação espera a vez uma única vez. O custo é a espera em fila numa wallet muito disputada — o
`lock_timeout` impede que isso pendure: estourou, a API responde 503 e o provedor reenvia.

`version` continua existindo (incrementa só quando o saldo muda) e serve de ordem do ledger.

### Idempotência

Dentro do lock, busca por `(provider, idempotency_key)` ou `(provider, id externo)`:

- mesma key **e** mesmo hash → replay: a resposta original com `idempotentReplay: true`;
- qualquer outra coincidência → 409 conflito (nunca replay).

A deduplicação é toda no banco (constraints únicas), nada em memória. Corrida com a mesma key
para wallets diferentes (locks diferentes): a constraint de idempotência estoura, a transação é
refeita (até 3 vezes) e na segunda passada cai no replay ou no conflito. Só essas duas constraints
disparam o retry; qualquer outra violação é bug e sobe como 500.

O payload é validado pelo domínio **antes** de pegar o lock: payload inválido não segura a wallet.

**Hash do payload:** SHA-256 em hex do JSON canônico — chaves em ordem alfabética, sem espaços,
campos ausentes omitidos — dos campos de negócio: `providerId`, `externalTransactionId`,
`playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`.
O `money` passa pelo `Money` antes, então `"25.0"` e `"25.00"` são o mesmo payload. O header
`Idempotency-Key` e metadados de transporte ficam de fora.

**Regra 7 (saldo observado):** cada transação grava `observed_balance`, o saldo da wallet quando
ela foi decidida. O replay devolve esse valor, inclusive para LOSS e REJECTED, que não têm lançamento.

### Camadas

`src/application` orquestra; `wager.repository.ts` faz o SQL dentro da transação. Não há interface
de repositório: existe uma implementação só, e os testes usam Postgres real (o desafio proíbe
substituir o banco por mock), então a interface seria cerimônia sem uso.

## API HTTP

| Situação | Status | Corpo |
|---|---|---|
| Transação PROCESSED (primeira vez ou replay) | 200 | resultado |
| Wallet criada | 201 | wallet |
| Transação aceita, aguardando a referência | 202 | resultado com `PENDING_REFERENCE` |
| Payload inválido, header `Idempotency-Key` ausente | 400 | `{ error, message }` |
| Wallet ou transação não existe | 404 | `{ error, message }` |
| Conflito de idempotência, wallet duplicada | 409 | `{ error, message }` |
| Rejeitada por regra de negócio | 422 | resultado com `failureCode` |
| Falha transitória (conexão, lock timeout, deadlock) | 503 + `Retry-After` | `{ error, message }` |
| Bug | 500 | `{ error, message }` |

O provedor decide só pelo status: 200/202/422 são respostas definitivas (reenviar devolve a mesma
coisa), 400/409 pedem correção do payload, 503 pode reenviar, 404 é wallet errada.

O replay devolve o estado gravado da transação: igual à primeira resposta, com uma exceção — uma
PENDING_REFERENCE (202) resolvida depois responde com o desfecho (200 ou 422). Quem resolver a
pendência (worker da parte 5) grava o saldo observado do momento da decisão.

**503 de verdade:** o conversor de erros do MikroORM para Postgres só reconhece deadlock; lock
timeout e conexão recusada chegam como erro genérico. Por isso `transient-errors.ts` olha o SQLSTATE
do Postgres (`55P03` lock timeout, `08xxx` conexão, `57P0x` banco reiniciando, `53300` conexões
esgotadas) e o código de rede do Node. Os dois casos principais têm teste (wallet travada além do
`lock_timeout` e Postgres fora do ar).

- **Ledger:** `GET /wallets/:id/ledger?cursor=&limit=` (padrão 50, máximo 200). O cursor é a
  `wallet_version` do último item em base64url: atribuída sob o lock, é estritamente crescente por
  wallet, então a página nunca pula nem repete item (`created_at` dependeria do relógio de cada instância).
- **Reconciliação:** saldo gravado × créditos − débitos do ledger, lidos na mesma foto do banco
  (`REPEATABLE READ`). Divergência é logada e sinalizada em `consistent: false`; nunca corrigida.
- `providerId = "internal"` é reservado para as transações OPENING e recusado na API.

## Interpretações das regras de negócio

### Uma dúvida sobre REFUND e ROLLBACK na mesma aposta

Lendo as regras da seção 7, uma combinação me chamou atenção:

> 3. `REFUND` só referencia `BET`. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`.
> 4. Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.

O detalhe está no "pelo mesmo tipo". A regra impede dois REFUNDs na mesma aposta, ou dois
ROLLBACKs, mas não impede um REFUND seguido de um ROLLBACK. Como os dois podem apontar para uma
`BET`, isso é possível:

```
BET      -80.00   saldo  20.00
REFUND   +80.00   saldo 100.00   (devolve a aposta)
ROLLBACK +80.00   saldo 180.00   (devolve a mesma aposta de novo)
```

O jogador apostou 80 e recebeu 160 de volta.

Sei que REFUND e ROLLBACK não são a mesma coisa: o REFUND é o reembolso de uma aposta cancelada,
e o ROLLBACK desfaz uma operação que não deveria ter acontecido (de um WIN, por exemplo, ele tira
o prêmio). Mas quando o alvo é uma `BET`, os dois fazem exatamente o mesmo: devolvem o valor
apostado. Na prática, a aposta acaba sendo devolvida duas vezes.

**O que eu fiz:** segui a regra como está escrita, uma reversão por tipo. É a regra de negócio
que foi passada, e não achei correto mudá-la por conta própria.

**O que eu acho:** não me parece a regra certa. Isso bate de frente com o invariante da seção 3
("o sistema não pode duplicar créditos"), e em produção seria uma brecha: quem descobrisse
poderia gerar dinheiro repetindo esse ciclo de aposta, reembolso e rollback.

**O que eu sugeriria:** cada transação só poder ser revertida uma vez, independente do tipo. O
ROLLBACK de um REFUND continuaria valendo, porque aí ele desfaz o reembolso. A mudança seria
pequena: no banco, a restrição de unicidade da reversão passa de `(referência, tipo)` para só
`(referência)`, e no domínio a checagem deixa de olhar o tipo. Deixo registrado para ser
conversado com o time, em vez de alterar a regra sem avisar.

### WIN ou LOSS sobre uma aposta já devolvida — ponto em aberto

O desafio não diz o que fazer se chegar um `WIN` referenciando uma `BET` que já foi reembolsada
(REFUND) ou desfeita (ROLLBACK). Hoje ele é aceito e credita o prêmio, porque nenhuma regra proíbe.
Pela mesma lógica da dúvida acima, um prêmio sobre uma aposta cancelada provavelmente não deveria
ser pago. Não alterei: fica para alinhar com o time, junto com a regra 4.

## Limitações conhecidas

- LocalStack fixado em 4.12: a imagem `latest` passou a exigir auth token (2026.03.0).
- Postgres exposto na porta 5434 do host (5432/5433 costumam estar ocupadas), só em `127.0.0.1`.
- Migrations sem lock: a garantia de execução única vem do serviço `migrate` do compose. Rodar
  `migration:up` de vários lugares ao mesmo tempo não é seguro.
- O container roda `bun src/main.ts` direto: via `bun run` o SIGTERM terminava em crash (exit 139).
- Uma wallet muito disputada vira fila no lock: a latência cresce com a disputa (correção acima de vazão).
- Transações PENDING_REFERENCE ficam paradas até o worker da parte 5 reprocessá-las.
- `POST /wallets` não é idempotente: se o cliente perder a resposta e reenviar, recebe 409 e
  precisa descobrir o id por outro caminho (o desafio não pede busca de wallet por player).
- A migration 2 preenche `wallet_version` e `observed_balance` das linhas antigas a partir do
  ledger; transações antigas sem lançamento (LOSS/REJECTED) ficam sem saldo observado, por isso a
  regra entrou como `NOT VALID` (vale para linhas novas).
- Reconciliação soma créditos e débitos de toda a vida da wallet: acima de 10^18 de movimento
  acumulado a soma não cabe no `Money` (limite de `NUMERIC(20,2)`).
