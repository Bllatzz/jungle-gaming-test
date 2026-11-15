# ARCHITECTURE

Decisões, trade-offs e limitações do Distributed Wagering Processor.

## Leitura rápida

O resto deste documento detalha cada ponto; para uma visão de uma tela, basta isto:

- **Dinheiro:** `Money` sobre `decimal.js`, string com exatamente 2 casas na entrada, `numeric(20,2)` no banco. Ver [Money](#money).
- **Concorrência:** `SELECT … FOR UPDATE` por wallet, com `lock_timeout` de 5 s → 503. Sem lock global. Ver [Processamento](#processamento-de-uma-transação-srcapplication).
- **Idempotência:** `UNIQUE (provider_id, idempotency_key)` e `(provider_id, external_transaction_id)`, hash SHA-256 do payload canônico, replay com o saldo da época. Ver [Idempotência](#idempotência).
- **Garantias no banco:** CHECKs, FKs compostas, ledger imutável por trigger e saldo == ledger checado no commit. O app conecta com um role sem ownership. Ver [Schema](#schema-e-garantias-no-banco).
- **Mensageria:** inbox `(consumer_name, message_id)` na mesma transação do efeito. Outbox publicada depois do commit, em ordem estrita por wallet (sequência do banco, não relógio), com lease e `SKIP LOCKED`. Ver [Mensageria](#mensageria-e-workers).
- **Fora de ordem:** REFUND/ROLLBACK sem referência ficam `PENDING_REFERENCE`, e um worker com backoff resolve ou expira em `REFERENCE_NOT_FOUND`. Ver [Referências fora de ordem](#referências-fora-de-ordem-71).

## Visão geral

Serviço NestJS que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas
por HTTP e por SQS, mantendo saldo materializado e ledger imutável consistentes sob entrega
at-least-once, mensagens fora de ordem e múltiplas instâncias.

Camadas:

- `src/domain` — regras de negócio em TypeScript puro. Não importa Nest, ORM nem AWS SDK
  (garantido por teste: `test/unit/domain/purity.test.ts`).
- `src/application` — use cases. Falam com o mundo de fora só pelas portas de
  `src/application/ports.ts` (ver [Camadas](#camadas)); não importam `src/infrastructure`, o ORM, o
  Nest nem o OpenTelemetry (garantido por teste, no mesmo `purity.test.ts`).
- `src/infrastructure` — HTTP, SQS, persistência (MikroORM), observabilidade.

## Topologia

Um único app faz tudo (API HTTP, consumer SQS, worker da outbox, worker de pending-reference)
e roda em N réplicas idênticas.

- **Por quê:** uma imagem e uma config; "≥ 3 instâncias" são 3 processos iguais; todo worker
  precisa ser seguro sob concorrência desde o início.
- **Coordenação pelo banco, não por processo líder:** `SELECT … FOR UPDATE` por wallet e
  `FOR UPDATE SKIP LOCKED` na outbox. Qualquer réplica pode morrer sem que nada pare.
- **Alternativas descartadas:** papéis por variável (`ROLE=api|worker`) — mais combinações para
  testar sem ganho no escopo do desafio; serviços separados — triplica setup em 48h.
- **Trade-off:** API e workers não escalam de forma independente.

## Stack e resultado do spike (Bun + NestJS + MikroORM)

Versões no momento do spike (as exatas ficam no `bun.lock`): Bun 1.3.13, NestJS 12.5, MikroORM 7.2,
TypeScript 7.0, PostgreSQL 16, LocalStack 4.12.

**Por que MikroORM (e não TypeORM):** é o preferencial do desafio e tem o que este domínio usa:
`em.transactional()` com fork por transação (nada vaza entre requisições concorrentes), `LockMode`
para o `FOR UPDATE`, `EntitySchema`/`defineEntity` sem decorators (o domínio fica puro e as entidades
de persistência são separadas) e tipo `decimal` mapeado como string (o `Money` nunca passa por
`number`). O mapeamento do `Money` está em [Mapeamento](#mapeamento) e a estratégia transacional em
[Processamento de uma transação](#processamento-de-uma-transação-srcapplication).

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
que o Bun 1.3 não suporta. Solução: `migrationsList` montado em
`src/infrastructure/persistence/migrations/index.ts` com `readdirSync` da pasta (arquivos
`Migration<14 dígitos>.ts`, em ordem de nome) e `import()` de cada um. Migration nova não precisa
ser registrada à mão.

**Migrations com lock:** `migrate.ts` pega `pg_advisory_lock` numa conexão reservada antes de
`up`/`down`: dois `migration:up` ao mesmo tempo (deploys, réplicas) rodam um depois do outro. O lock é
de sessão, então some se o processo morrer. O serviço `migrate` do compose continua rodando uma vez só.

**Migrations sem Node:** a CLI do MikroORM depende de Node; usamos um script próprio
(`src/infrastructure/persistence/migrate.ts`) que reutiliza a mesma config do app.

**Nada roda sob Node** — a imagem `oven/bun` não tem Node. `tsc` 7 é binário nativo.

## Filas

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | Entrada de transações. `VisibilityTimeout=30`; o app manda para a DLQ no 5º recebimento com falha, redrive após 10 como rede de segurança |
| `wager-transactions-dlq.fifo` | Mensagens com falha permanente ou que esgotaram as tentativas |
| `wallet-events.fifo` | Saída: destino dos eventos publicados pela outbox. O desafio pede publicação mas não define o destino; decisão nossa |

Deduplicação e ordenação do SQS FIFO são **otimização**. A garantia de não duplicar efeitos é
do banco — inbox persistente e constraints de unicidade (ver [Mensageria](#mensageria-e-workers)).
`MessageDeduplicationId` é sempre explícito (`eventId` na outbox, `MessageId` do SQS ao mandar para a DLQ).

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

## Logs e métricas

**Logs:** `JsonLogger` (o logger do Nest trocado por um de ~30 linhas): uma linha JSON por evento no
stdout — `{ time, level, context, msg, ...campos }`. Os logs internos do Nest saem no mesmo formato.

- Toda transação decidida (HTTP ou SQS, inclusive replay) gera `wager transaction decided` com
  `correlationId`, `messageId` (na fila), `transactionId`, `walletId`, `providerId`, `kind`, `status`,
  `failureCode`, `replay` e `durationMs`. O consumer loga `sqsMessageId`/`messageId`/`receiveCount`
  em retry e DLQ; o worker de referências loga `transactionId`, `walletId`, `providerId`.
- **Sem dados financeiros:** nada de valores, saldos ou payload no log. Exceção consciente: a
  divergência de reconciliação loga a diferença — é o dado que o operador precisa.

**Métricas:** `GET /metrics` em formato Prometheus, sem autenticação (como os health checks).

| §12 pede | Métrica |
|---|---|
| Transações por status | `wager_transactions_total{source,status}` — source: `http`, `sqs`, `pending_worker` |
| Duplicatas detectadas | `wager_duplicates_total{source}` (replay idempotente, inclusive redelivery da fila) e `wager_conflicts_total{code}` |
| Retries | `wager_retries_total{component}` — `sqs_consumer`, `outbox`, `pending_reference` |
| Mensagens em DLQ | `sqs_dead_lettered_total{error_code}` e `sqs_dlq_messages` (profundidade da DLQ) |
| Conflitos de lock | `wager_lock_conflicts_total{type}` — `lock_timeout`, `deadlock`, `idempotency_race` |
| Outbox lag | `outbox_lag_seconds` (idade do evento pendente mais antigo) e `outbox_pending_messages` |
| Latência de processamento | `wager_processing_duration_seconds{source}` (histogram) |
| Divergência de reconciliação (§9) | `reconciliation_divergences_total` |

- Os contadores com labels conhecidos (status, source, component, type, error_code) aparecem com 0 desde
  o start: `rate()`/`increase()` e alertas funcionam logo depois do deploy.
- Contadores e histogram são por instância (o Prometheus soma as réplicas). Os gauges vêm do banco e
  do SQS na hora do scrape, então valem para o sistema todo.
- `wager_transactions_total` conta **decisões**: uma REFUND que chega antes da BET conta
  `PENDING_REFERENCE` na entrada e depois `PROCESSED` com `source="pending_worker"`.
- Contagem e log só depois do commit (worker e publisher inclusive): nunca contam trabalho desfeito.
  E uma falha de log/métrica depois do commit não vira erro para quem chamou.
- Com banco ou SQS fora, o scrape devolve o que der (sem o gauge que falhou), nunca 500. Alerta de
  "gauge sumiu" é com `absent()` no Prometheus. A query da outbox tem `statement_timeout` de 2 s:
  scrape com banco lento não segura conexão do pool.
- Falhas também logam com os ids (`wager transaction failed`, e o consumer em retry/DLQ com
  `messageId`, `walletId`, `providerId`). O log de erro HTTP usa o mesmo `correlationId` do use case.
- `/metrics` sem autenticação, como os health checks: em produção, exposto só na rede interna.
- Registro próprio em vez de `prom-client`: são ~60 linhas para counter e histogram, sem dependência.
  Trocar se precisar de métricas de processo (CPU, heap) ou summaries.

**Dashboard:** perfil `observability` do compose sobe Prometheus (scrape a cada 5 s) e Grafana com
datasource e dashboard provisionados (`docker/grafana/provisioning`), abrindo direto no
"Wagering Processor". As réplicas do compose são descobertas pelo DNS do Docker (`dns_sd_configs`
em `app`, um alvo por réplica, inclusive depois de `--scale`); o app no host e os 3 processos do
`test:load` entram como alvos estáticos (`host.docker.internal`). Painéis: transações/s por status,
latência p50/p95/p99 (`histogram_quantile` sobre o histogram somado das réplicas), outbox lag e
pendentes, instâncias no ar, duplicatas e conflitos de idempotência, conflitos de lock, retries, DLQ e
divergências de reconciliação. Os gauges vêm do banco/SQS e são iguais em toda réplica, por isso
`max()` e não `sum()`. Conferido com 3 réplicas: 3 alvos `up`, painéis com dados.

**Tracing (OpenTelemetry):** instrumentação manual (a auto-instrumentação do OTel para Node depende de
hooks de módulo que o Bun não suporta por completo), em `src/infrastructure/observability/tracing.ts`.
Ligado por `OTEL_EXPORTER_OTLP_ENDPOINT`; sem ele, nenhum span é exportado e o custo é desprezível.

- Span `HTTP {método} {rota}` por requisição (interceptor global), filho do `traceparent` do cliente
  se vier, com status HTTP e o desfecho da transação (`wager.transaction_id`, `status`, `replay`,
  `wallet_id`, `provider_id`, `kind`, `correlation_id`).
- O `traceparent` do span ativo vai junto com o evento na outbox (coluna `traceparent`, migration 8) e
  sai como atributo da mensagem SQS no publish (span `outbox.publish`). O trace atravessa o commit e o
  publisher assíncrono.
- O consumer abre `sqs.process wager-transactions` como filho do `traceparent` da mensagem recebida.
- Exporter OTLP/HTTP para o Jaeger do perfil `observability` (UI em http://localhost:16686).
- Teste: `test/integration/tracing.test.ts`, com o SDK de verdade e exporter em memória (pai do span,
  `traceparent` na outbox e no SQS, span do consumer). Conferido no compose: o Jaeger recebeu os spans
  das 3 réplicas com o trace id do cliente.
- Não instrumentado: spans por query SQL e por chamada AWS SDK (precisaria da auto-instrumentação).

## Autenticação

Implementada com IdP externo, **desligada por padrão** (`AUTH_ISSUER` + `AUTH_JWKS_URL` ligam; as duas
juntas ou nenhuma, senão o boot falha). Desligada, o `AuthGuard` deixa tudo passar, como antes.

- **IdP:** Keycloak no compose (perfil `auth`), realm `wagering` importado de
  `docker/keycloak/wagering-realm.json`. Cada provedor de jogos é um client OIDC confidencial com
  *client credentials* (máquina a máquina, sem usuário) e um mapper que põe o claim `provider_id` no
  access token. Nenhuma tabela de usuário ou senha no serviço.
- **Validação** (`src/infrastructure/http/auth.guard.ts`, lib `jose`): assinatura RS256 pela JWKS do
  IdP (cache e troca de chave pela própria lib), emissor e expiração. Token sem `provider_id` → 401.
- **Um provedor não age em nome de outro:** o `providerId` do body (`POST /wagering/transactions`) ou
  da rota (`/providers/:providerId/...`) tem que ser o do token → senão 403 `FORBIDDEN_PROVIDER`, antes
  de qualquer gravação. `GET /wagering/transactions/:id` de outro provedor responde 404 (não confirma
  que o id existe).
- **Status:** 401 `UNAUTHENTICATED` (sem token, assinatura/emissor errado, vencido); 403
  `FORBIDDEN_PROVIDER`; 503 + `Retry-After` com o IdP fora (não é culpa do token, o provedor reenvia).
- **Fora da autenticação:** health checks e `/metrics` (rede interna) e mensagens SQS (canal interno
  confiável, §2); o `providerId` da mensagem segue validado pelo domínio.
- **Emissor fixo:** `KC_HOSTNAME=http://localhost:8180` faz o `iss` ser o mesmo para token pedido no
  host ou dentro da rede do compose; o app no container busca a JWKS em `keycloak:8080`.
- Testes (`test/integration/auth.test.ts`): um IdP de mentira publica uma JWKS real e os testes assinam
  tokens RS256; cobre todos os 401, os 403, o 404 entre provedores e o 503 com o IdP fora. O fluxo com o
  Keycloak de verdade foi conferido à mão (token por client credentials → 201/200; token do
  `provider-b` com payload do `provider-a` → 403), mas não entra na suíte automática para não exigir o
  Keycloak (~20 s de boot) em toda execução.
- Limitações: sem checagem de `aud` (o Keycloak põe `account` por padrão; em produção, um mapper de
  audience e `audience` no `jwtVerify`); wallets não pertencem a provedor, então qualquer provedor
  autenticado lê ou abre qualquer wallet; sem escopos/papéis (todo client pode tudo nas suas transações).

## Domínio (`src/domain`)

TypeScript puro: nenhum import de Nest, ORM ou AWS SDK (há um teste que garante isso). Todas as
classes têm construtor privado e factories (`create`/`from`/`open` validam; `rehydrate` só reconstrói).

### Money
- `decimal.js` com precisão de 40 dígitos: somas e subtrações de valores com 2 casas nunca arredondam.
- Entrada (`Money.from`) aceita só `^(0|[1-9]\d{0,17})\.\d{2}$` (escala fixa de 2 casas): rejeita vazio, espaço, sinal,
  `NaN`, `Infinity`, notação científica, zero à esquerda, menos ou mais de 2 casas (`"25"`, `"25.5"`, `"25.001"`) e mais de 18 dígitos
  inteiros (o limite cabe em `NUMERIC(20,2)`). `amount` precisa ser string: um `number` vindo do JSON é rejeitado.
- Internamente pode ficar negativo (ex.: diferença da reconciliação). Saída sempre com 2 casas.
- Moedas diferentes lançam `CurrencyMismatchError`. O modelo é multi-moeda; o desafio usa BRL.

### Wallet e ledger
- `debit`/`credit` validam e **devolvem o lançamento** criado: saldo e ledger nascem juntos.
- `version` começa em 1 e só incrementa quando o saldo muda (movimento de valor zero é rejeitado).
- `WalletLedgerEntry` é imutável de verdade: campos `readonly`, nenhum método de transição e
  `Object.freeze`. `create` valida `balanceBefore ± money === balanceAfter` e saldo final ≥ 0.
- Ledger da wallet: um lançamento por transação por wallet (`wallet_ledger_entries`, o que o §6.4
  pede). Por cima dele, **partidas dobradas** em `ledger_postings` (ver Persistência).
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
As regras moram nos agregados: `WagerTransaction` sabe que referência aceita (`acceptsReference`,
`canReference`), se a referência é do mesmo contexto (`sharesContextWith`, regra 2) e o que há de
errado com ela (`referenceFailure`, regras 3 a 5); `Wallet` sabe se cobre um débito (`canDebit`).
`applyWager` é só a ordem em que elas são consultadas e a aplicação do resultado; o use case carrega
os dados e persiste. Assim cada regra é testada sem banco. Antes de tudo, duas guardas de programação (lançam erro sem
tocar na wallet): transação já terminal e transação de outra wallet. Depois, a primeira checagem
que falha decide:

1. moeda da transação = moeda da wallet; player = dono da wallet;
2. se há referência:
   - o tipo não aceita referência (ex.: BET) ou a transação referencia a si mesma →
     `REFERENCE_INVALID_KIND` na hora (esperar não resolveria);
   - referência de outro player/wallet/moeda/rodada → `REFERENCE_MISMATCH`, mesmo que ela
     ainda esteja pendente. Outro *provider* não chega aqui: a referência é procurada por
     `(providerId, referenceExternalTransactionId)` (regra 2), então a transação de outro provider é
     invisível e conta como ausente (`PENDING_REFERENCE`, e `REFERENCE_NOT_FOUND` no fim do prazo).
     De propósito: o id externo é do espaço de nomes de cada provider, e dois providers podem usar o
     mesmo id. Rejeitar na hora porque "existe em outro provider" recusaria uma reversão legítima cuja
     referência ainda está em voo (regra 8). É a leitura literal das regras 2 e 8: resolvida por
     `(providerId, …)`, a referência simplesmente não existe para este provider;
   - referência de tipo não permitido (ex.: REFUND de um WIN) → `REFERENCE_INVALID_KIND`, também
     mesmo pendente (o tipo dela não muda esperando);
   - ausente ou ainda não aplicada → `PENDING_REFERENCE`;
   - senão precisa estar `PROCESSED`, ter tipo compatível (REFUND→BET; ROLLBACK→BET/WIN/REFUND;
     WIN e LOSS→BET), **não ter nenhuma reversão PROCESSED** (REFUND ou ROLLBACK, de qualquer tipo —
     ver Interpretações) e ter o mesmo valor (REFUND/ROLLBACK). Vale também para WIN/LOSS: prêmio
     sobre uma aposta já devolvida é `REFERENCE_ALREADY_REVERSED`. "Já revertida" vem antes de
     "valor errado" para o provedor receber o sinal de não reenviar;
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
| `REFERENCE_NOT_FOUND` | Referência não chegou no prazo (10 tentativas, ~4 min) | Reenviar a referência ou desistir |
| `REFERENCE_NOT_PROCESSED` | Referência existe, mas foi rejeitada/falhou (ou continuou pendente até o prazo) | Não reenviar |
| `REFERENCE_MISMATCH` | Referência de outro player/wallet/moeda/rodada (outro provider conta como ausente) | Corrigir o payload |
| `REFERENCE_INVALID_KIND` | Tipo de referência não permitido | Corrigir o payload |
| `REFERENCE_ALREADY_REVERSED` | A referência já tem um REFUND ou ROLLBACK aplicado (inclusive WIN/LOSS sobre BET já devolvida) | Não reenviar |
| `AMOUNT_MISMATCH` | Valor da reversão diferente da referência | Corrigir o payload |
| `INTERNAL_ERROR` | Erro que não é regra de negócio e se repetiu até esgotar as tentativas (`FAILED`) | Não reenviar; contatar o suporte |

**Quando `FAILED` é gravado:** no worker de PENDING_REFERENCE. Uma transação já gravada que dá erro
**não transitório** ao ser reavaliada (bug, dado que o código não sabe tratar) gasta uma tentativa, igual
a uma referência ausente; esgotadas as 10, termina `FAILED` com `INTERNAL_ERROR` e evento
`WagerTransactionFailed`. Erro transitório (banco fora, lock timeout — mesma classificação do 503)
adia 60 s sem gastar tentativa: passa sozinho, e não deve virar desfecho definitivo. O replay de uma
`FAILED` responde 422 com o corpo do resultado (`status: FAILED`, terminal): como o REJECTED, é desfecho
gravado e sem efeito no saldo, e reenviar não muda nada; 500 fica só para bug. Na entrada HTTP e na
fila não há `FAILED`: lá o erro desfaz a transação SQL inteira, nada fica gravado, e o provedor
recebe 503/500 (HTTP) ou a mensagem vai para retry/DLQ.

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
| Ledger imutável | trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE`; o role do app nem tem esses privilégios (ver Roles) |
| Lançamento coerente | `CHECK` da aritmética `before ± amount = after`; `amount > 0` |
| Lançamento na moeda da wallet | FK composta `(wallet_id, currency)` → `wallets (id, currency)` |
| Lançamento bate com a sua transação | FK composta `(transaction_id, wallet_id, amount, currency)` → `wager_transactions` |
| No máximo um lançamento por transação | `UNIQUE (transaction_id)` |
| Idempotência | `UNIQUE (provider_id, idempotency_key)` |
| Referência resolvida por provider + id externo | `UNIQUE (provider_id, external_transaction_id)` |
| REFUND/ROLLBACK exigem referência | `CHECK` |
| Regra 4 (uma reversão por referência, de qualquer tipo) | índice único parcial `(reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` (migration 6), mais `CHECK` exigindo a referência resolvida (NULL escaparia do índice) e proibindo auto-referência |
| Regra 2 (referência do mesmo contexto) | FK composta `(reference_transaction_id, provider_id, player_id, wallet_id, currency, round_id)` → a transação referenciada (migration 6) |
| Saldo == ledger | constraint triggers deferidos (migration 7): cada lançamento continua o anterior (`wallet_version` + 1, `balance_before` = `balance_after` anterior, o primeiro parte de 0) e a wallet bate com o último lançamento (`balance` e `version`); sem lançamento, saldo 0. Logo `balance = Σ créditos − Σ débitos` |
| Abertura de wallet idempotente | `UNIQUE (open_idempotency_key)` + `CHECK` key ⇔ hash |
| Transação é auditável | trigger: linha terminal não muda; nenhuma linha é apagada; campos do payload (os que entram no `payload_hash`) nunca mudam |
| Status coerente com os campos | `processed_at` ⇔ `PROCESSED`; `failure_code` ⇔ `REJECTED`/`FAILED` |
| Inbox deduplica | `PRIMARY KEY (consumer_name, message_id)` |
| Replay devolve o saldo daquele momento (regra 7) | `observed_balance` obrigatório em `PROCESSED`/`REJECTED` |

`wager_transactions` **não** tem FK de moeda nem de player com a wallet de propósito: uma transação
rejeitada por `CURRENCY_MISMATCH` ou `WALLET_PLAYER_MISMATCH` precisa ficar gravada para auditoria.

Índices além das constraints: `UNIQUE (wallet_id, wallet_version)` no ledger (histórico por
cursor, uma versão = um lançamento), parcial `WHERE status = 'PENDING_REFERENCE'` para achar quem espera uma referência,
parcial `WHERE published_at IS NULL` em `occurred_at` (lag da outbox), em
`(next_attempt_at, occurred_at, id)` (claim do publisher, migration 4) e em `(aggregate_id, seq)` (cabeça de
cada wallet no claim).

### Roles: migration × runtime

O app **não** conecta como dono das tabelas. `wagering` (dono, `MIGRATION_DATABASE_URL`) só roda
migrations; o app usa `wagering_app` (`DATABASE_URL`), membro do role de grupo `wagering_runtime`.
Os dois logins nascem em `docker/postgres/init-roles.sql`, idempotente: roda no init do volume e de novo
pelo serviço `roles` do compose a cada `bun run infra:up` / `docker compose up` (antes do `migrate`), então um
volume criado antes dele ganha os roles sem ser recriado. Em produção os logins viriam da infra (IaC). Os grants
ficam na migration `Migration20261115130000`:

- `wallets`, `wager_transactions`, `inbox_messages`, `outbox_messages`: `SELECT, INSERT, UPDATE`;
- `consumer_message_failures`: também `DELETE` (a linha some quando a mensagem tem desfecho);
- `wallet_ledger_entries`, `ledger_postings`: só `SELECT, INSERT` — append-only também por privilégio.

Sem ownership, o app não consegue `ALTER TABLE … DISABLE TRIGGER`: as garantias do schema (imutabilidade,
saldo == ledger) não dependem de um role que poderia desligá-las. Um bug ou injeção de SQL no app recebe
`permission denied` / `must be owner` (testado em `schema.test.ts` conectando como o role do app). Os testes
de integração e concorrência rodam o app com esse role; só helpers que precisam contornar o banco de
propósito (`corruptBalance`) conectam como dono.

Tabela nova de migration futura: `ALTER DEFAULT PRIVILEGES` (migration `Migration20261115150000`) já dá
`SELECT, INSERT` (e `USAGE, SELECT` nas sequências) ao `wagering_runtime`. O padrão é append-only: `UPDATE`
e `DELETE` continuam pedindo grant explícito na migration que cria a tabela (testado com uma tabela criada
pelo dono depois das migrations).

### Partidas dobradas (`ledger_postings`, migration 5)

Cada lançamento da wallet vira duas partidas, na mesma transação SQL:

| Movimento | Conta da wallet (`wallet:<id>`) | Contrapartida (`provider:<providerId>`) |
|---|---|---|
| OPENING 100 | CREDIT 100 | `provider:internal` DEBIT 100 |
| BET 30 | DEBIT 30 | CREDIT 30 |
| WIN / REFUND / ROLLBACK de BET | CREDIT | DEBIT |
| ROLLBACK de WIN | DEBIT | CREDIT |

A wallet é passivo da casa com o jogador (crédito aumenta); a contrapartida é a conta do provedor na
mesma moeda. Débitos = créditos em cada transação, logo no livro inteiro, e o saldo da conta `wallet:<id>`
é o saldo da wallet.

- **Geradas por trigger** `AFTER INSERT` em `wallet_ledger_entries`, não pelo app: nenhum caminho (HTTP,
  fila, worker de referências, abertura) move saldo sem as duas pernas, e o domínio continua com o
  lançamento simples do §6.4. Trade-off: as partidas são derivadas do lançamento da wallet, e não um
  modelo de domínio próprio; em troca, zero mudança no use case e garantia de que nunca divergem.
- **Fecham no commit:** constraint trigger `DEFERRABLE INITIALLY DEFERRED` recusa a transação SQL se
  débitos ≠ créditos para alguma transação (as duas pernas entram em comandos separados, por isso deferido).
- Append-only (trigger bloqueia `UPDATE`, `DELETE`, `TRUNCATE`); `UNIQUE (transaction_id, account)`.
- Migration em banco com dados: os lançamentos antigos ganham as duas pernas no `up`.
- A invariante final das suítes (`walletsDivergingFromLedger`) confere também saldo == conta da wallet
  nas partidas; `schema.test.ts` confere as pernas de cada tipo, o balancete do banco inteiro (Σ = 0),
  a partida que não fecha e o append-only.
- Custo: 2 inserts a mais por movimento, dentro do lock da wallet (ver Teste de carga).

Cada linha da tabela acima tem um teste em `test/integration/schema.test.ts` que tenta violá-la.
Os testes de integração rodam num banco próprio (`<banco>_test`, recriado a cada execução), nunca no
banco do dev — o ledger é append-only e não dá para limpar.

Os triggers levantam o erro padrão do PL/pgSQL (`P0001`), não `check_violation`: quebrar uma regra
de imutabilidade é erro de programação, e o app consegue diferenciar de um `CHECK` comum.

O que o banco **não** garante (fica no domínio): que a referência é do tipo certo (REFUND→BET etc.:
regra entre linhas, sem constraint declarativa), que WIN/LOSS não referenciam BET já revertida e que só
transação `PROCESSED` gera lançamento. O contexto da referência (regra 2) e saldo == ledger passaram
para o schema nas migrations 6 e 7.

**Saldo == ledger, como:** o trigger confere no commit (`DEFERRABLE INITIALLY DEFERRED`, porque
lançamento e saldo são comandos separados da mesma transação) só o último lançamento e o anterior,
pelo índice `(wallet_id, wallet_version)`: custo constante por transação, não uma soma do histórico.
Alternativa descartada: só o job de reconciliação — detecta depois, não impede. Os dois ficaram: o
trigger impede, e a auditoria periódica (worker `ledger audit`, a cada 5 min em toda instância) pega o
caso de alguém contornar o banco (trigger desligado, restore parcial), comparando saldo × Σ ledger ×
conta da wallet nas partidas dobradas; divergência vira métrica `reconciliation_divergences_total` e
log de erro, nunca correção.

## Processamento de uma transação (`src/application`)

`ProcessWagerTransaction` é o único caminho de uma transação de aposta — a API HTTP e o consumer
SQS usam o mesmo. Tudo numa transação SQL só, nesta ordem:

0. **Replay sem lock:** se já existe transação **terminal** com a mesma key/id externo (e, pela
   fila, a mensagem já está no inbox), responde o replay direto do que está commitado, sem esperar o
   lock da wallet. Seguro porque transação terminal nunca muda (trigger). PENDING_REFERENCE (pode estar
   sendo resolvida neste instante) e mensagem nova no inbox seguem pelo caminho com lock. Custo: uma
   leitura a mais por transação nova.
1. `SELECT … FOR UPDATE` na wallet (com `lock_timeout` de 5 s).
2. Só pela fila: inbox `(consumerName, messageId)` — já visto segue para o replay; novo é gravado.
3. Idempotência: já existe transação com a mesma idempotency key ou o mesmo id externo do provider?
4. `applyWager` (domínio puro) decide.
5. Grava a transação → o lançamento → o saldo → os eventos na outbox (`recordDecision`, o mesmo
   usado pelo worker de referências).

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

Antes do lock (só terminais) e de novo dentro dele, busca por `(provider, idempotency_key)` ou
`(provider, id externo)`. A transação gravada volta como `WagerTransaction` do domínio, e a
comparação é dela (`idempotencyKey` e `matchesPayload(hash)`):

- mesma key **e** mesmo hash → replay: a resposta original com `idempotentReplay: true`;
- qualquer outra coincidência → 409 conflito (nunca replay).

**Escopo da key: por provider** (`UNIQUE (provider_id, idempotency_key)`). O header é a fonte da verdade,
mas cada provider gera as suas keys sem coordenação com os outros (o default recomendado,
`"{providerId}:{externalTransactionId}"`, já embute o provider; uma key livre como `"tx-1"` poderia
coincidir entre dois providers). Global, a colisão acidental viraria 409 para um provider que nunca
mandou aquela operação; por provider, a key de um não interfere no outro — o mesmo espaço de nomes que
a regra 2 dá ao id externo. Um provider que troca de `providerId` (migração, rebranding) passa a ser
outro escopo: as transações antigas continuam consultáveis pelo id antigo, e as reversões delas
precisam vir com o provider original, como a regra 2 já exige.

A deduplicação é toda no banco (constraints únicas), nada em memória. Corrida com a mesma key
para wallets diferentes (locks diferentes): a constraint de idempotência estoura, a transação é
refeita (até 3 vezes) e na segunda passada cai no replay ou no conflito. Só essas duas constraints
disparam o retry; qualquer outra violação é bug e sobe como 500.

O payload é validado pelo domínio **antes** de pegar o lock: payload inválido não segura a wallet.

**Hash do payload:** SHA-256 em hex do JSON canônico — chaves em ordem alfabética, sem espaços,
campos ausentes omitidos — dos campos de negócio: `providerId`, `externalTransactionId`,
`playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`.
O `money` entra como `Money.toString()` (a entrada já exige 2 casas, então só há uma grafia por valor). O header
`Idempotency-Key` e metadados de transporte ficam de fora.

**Regra 7 (saldo observado):** cada transação grava `observed_balance`, o saldo da wallet quando
ela foi decidida. O replay devolve esse valor, inclusive para LOSS e REJECTED, que não têm lançamento.

### Camadas

`src/application` orquestra e declara o que precisa em `ports.ts`; `src/infrastructure` implementa:

| Porta (`src/application/ports.ts`) | Adaptador | Para quê |
|---|---|---|
| `UnitOfWork` → `WagerStore` | `MikroUnitOfWork` → `WagerRepository` | Uma transação SQL; tudo que o store grava dentro dela é commitado junto |
| `MetricsRecorder` | `Metrics` (Prometheus em memória) | Contadores e histograma do §12 |
| `ReconciliationSource` | `WagerQueries` | Saldo + somas do ledger na mesma foto do banco; varredura do banco inteiro para a auditoria |

`UnitOfWork.isTransient(error)` também é porta: o worker de referências precisa distinguir falha
transitória de bug sem conhecer SQLSTATE.

As portas são `abstract class` porque o Nest usa a classe como token de injeção (`app.module.ts`
liga cada porta ao adaptador). Os use cases não têm decorators do Nest: o `app.module.ts` os monta por
factory, passando um `Logger` do Nest pela interface `AppLogger` (também em `ports.ts`). Os atributos
de tracing da decisão (`wager.*`) são postos no span pela entrada (controller HTTP e consumer), não pelo
use case. Do lado de leitura, os presenters HTTP declaram a forma que leem (`TransactionView`,
`LedgerEntryView`) em vez de importar as linhas do ORM. Detalhes do Postgres ficam no adaptador: o `MikroUnitOfWork` conta
conflito de lock na métrica e traduz violação de `UNIQUE` para `UniqueViolationError` (com o nome
da constraint), que é o que os use cases tratam. Os testes continuam com Postgres real — as portas
servem ao limite entre as camadas, não para trocar o banco por mock.

## API HTTP

| Situação | Status | Corpo |
|---|---|---|
| Transação PROCESSED (primeira vez ou replay) | 200 | resultado |
| Wallet criada (ou reenvio com a mesma `Idempotency-Key`) | 201 | wallet como foi aberta |
| Transação aceita, aguardando a referência | 202 | resultado com `PENDING_REFERENCE` |
| Payload inválido, header `Idempotency-Key` ausente | 400 | `{ error, message }` |
| Wallet ou transação não existe | 404 | `{ error, message }` |
| Sem token / token inválido (com auth ligada) | 401 | `{ error: UNAUTHENTICATED }` |
| Provedor agindo em nome de outro (com auth ligada) | 403 | `{ error: FORBIDDEN_PROVIDER }` |
| Conflito de idempotência, wallet duplicada | 409 | `{ error, message }` |
| Rejeitada por regra de negócio | 422 | resultado com `failureCode` |
| Falha transitória (conexão, lock timeout, deadlock) | 503 + `Retry-After` | `{ error, message }` |
| Bug | 500 | `{ error, message }` |
| Replay de transação `FAILED` | 422 | resultado com `status: FAILED`, `failureCode: INTERNAL_ERROR` (terminal) |

O provedor decide só pelo status: 200/202/422 são respostas definitivas (reenviar devolve a mesma
coisa), 400/409 pedem correção do payload, 503 pode reenviar, 404 é wallet errada. A mesma
`Idempotency-Key` reenviada com outro `walletId` (mesmo um inexistente) é 409, não 404: sem a wallet, o
use case ainda confere se a key já está gravada antes de responder "não existe".

O replay devolve o estado gravado da transação: igual à primeira resposta, com uma exceção — uma
PENDING_REFERENCE (202) resolvida depois responde com o desfecho (200 ou 422). O worker de
referências grava o saldo observado do momento em que resolveu. Por quê: o 202 não é um resultado,
é "ainda não decidido". A regra 7 fala de operação *já processada*, e o resultado original dela é a
decisão do worker (com o saldo daquele momento). Congelar o 202 deixaria o provedor sem nunca
saber o desfecho pelo mesmo canal. Enquanto continua pendente, o replay devolve o 202 com o saldo
da primeira resposta.

**503 de verdade:** o conversor de erros do MikroORM para Postgres só reconhece deadlock; lock
timeout e conexão recusada chegam como erro genérico. Por isso `transient-errors.ts` olha o SQLSTATE
do Postgres (`55P03` lock timeout, `08xxx` conexão, `57P0x` banco reiniciando, `53300` conexões
esgotadas) e o código de rede do Node. Os dois casos principais têm teste (wallet travada além do
`lock_timeout` e Postgres fora do ar).

- **Ledger:** `GET /wallets/:id/ledger?cursor=&limit=` (padrão 50, máximo 200). O cursor é o id
  do último lançamento da página, em base64url: opaco de verdade (não expõe posição nem contagem, não
  dá para fabricar um "pular para a página N") e só vale na própria wallet (outro id → 400). A ordem
  é `wallet_version`, atribuída sob o lock e estritamente crescente por wallet, então a página nunca
  pula nem repete item (`created_at` dependeria do relógio de cada instância).
- **Abertura idempotente:** `POST /wallets` aceita `Idempotency-Key` (opcional). Com ela, a key e o
  hash do pedido (SHA-256 do JSON canônico de `playerId` + `initialBalance`) ficam na wallet: reenviar
  o mesmo pedido devolve 201 com a wallet como foi aberta (saldo inicial, version 1), outro pedido com
  a mesma key → 409 `IDEMPOTENCY_CONFLICT`. Reenvios simultâneos: a constraint única desempata e o
  perdedor vira replay. Sem a key, a duplicata continua 409 `WALLET_ALREADY_EXISTS`. A key é única no
  sistema todo (wallet não pertence a provedor): use um prefixo próprio, ex. `{providerId}:open:{id}`.
- **Reconciliação:** saldo gravado × créditos − débitos do ledger, lidos na mesma foto do banco
  (`REPEATABLE READ`). Divergência é logada e sinalizada em `consistent: false`; nunca corrigida.
- `providerId = "internal"` é reservado para as transações OPENING e recusado na API.

## Mensageria e workers

Toda instância roda os quatro workers (consumer, publisher, referências e auditoria do ledger) (`src/infrastructure/workers`), coordenados só pelo banco —
sem eleição de líder. `WORKERS_ENABLED=false` sobe só a API (os testes de integração usam isso e
chamam cada volta direto, sem timers).

### Consumer (`wager-transactions.fifo`)

Uma regra só decide o destino da mensagem: **ack quando o desfecho está no banco**.

| Situação | O que acontece |
|---|---|
| PROCESSED, REJECTED (regra de negócio), PENDING_REFERENCE, replay | commit → `DeleteMessage` (ack) |
| JSON inválido, `type` desconhecido, payload inválido, wallet inexistente, conflito de idempotência, `messageId` reutilizado com outro payload | nada pode ser gravado → DLQ na hora, com atributo `errorCode` |
| Transitório (banco fora, lock timeout…) ou erro inesperado | sem ack; `ChangeMessageVisibility` com backoff 1s, 2s, 4s… (teto 60s) |
| 9ª falha **transitória** da mesma mensagem (~3 min de backoff) | DLQ com `RETRIES_EXHAUSTED` |
| 5ª falha **não transitória** (bug) da mesma mensagem | DLQ com `PROCESSING_FAILED` |

- **Inbox:** gravado dentro da mesma transação de wallet, ledger e outbox. O hash guardado é o do
  payload de negócio (o mesmo da idempotência): o produtor pode reenviar com outro `occurredAt`.
- **Ack só depois do commit.** Morreu entre o commit e o ack: a mensagem volta, cai no inbox/replay
  e é confirmada sem efeito novo. Três testes: determinístico (`spyOn` no delete), `kill -9` de
  processo real no meio da carga, e `kill -9` **exatamente** entre o commit e o ack
  (`test/concurrency/crash-after-commit.test.ts`: o processo roda com `FAULT_INJECTION=kill-after-commit`
  e se mata com SIGKILL logo depois do commit; outro processo recebe a redelivery). O ponto de injeção
  é uma linha no consumer, só ativa com a variável (validada no boot), nunca em produção.
- **Limite de tentativas** no app, com dois orçamentos: `MAX_TRANSIENT_RECEIVES = 9` para erro
  transitório (banco fora, lock timeout) e `MAX_RECEIVES = 5` para o resto (bug). Com o backoff
  1+2+4+8+16+32+60+60 s, uma queda do Postgres de até ~3 min (restart, failover) não manda mensagem
  válida para a DLQ: ela é aplicada quando o backoff vencer depois da volta do banco (teste: queda no 5º
  recebimento e volta → aplicada, DLQ vazia; medido também com o Postgres parado por 40 s). Queda maior
  que isso vai para a DLQ com `RETRIES_EXHAUSTED` e exige redrive. As falhas são contadas pelo app em
  `consumer_message_failures (consumer, messageId)`, numa transação própria (a do negócio foi
  desfeita). Não pelo `ApproximateReceiveCount`: ele também sobe quando a mensagem só é devolvida sem
  processar (irmã de grupo bloqueado, orçamento do lote, shutdown), e uma mensagem que nunca falhou
  chegaria à DLQ por isso. Com o banco fora não dá para contar: aí vale o `ApproximateReceiveCount`
  (fallback). A redrive policy (`maxReceiveCount = 10`) fica de rede de segurança, acima dos dois
  limites. A linha da contagem é apagada quando a mensagem tem desfecho (ack ou DLQ).
- **Ack falhou depois do commit:** só log, e a mensagem volta na hora (visibilidade 0) para cair no
  replay. Nunca vai para a DLQ: o efeito já está gravado.
- **Lote demorado:** o receive pede 30 s de visibilidade e o lote para em 20 s; o resto volta para a
  fila antes de vencer com a mensagem ainda em andamento.
- **Grupos em paralelo:** o lote (até 10) é separado por `MessageGroupId` (a wallet). Cada grupo é
  processado em ordem, e os grupos em paralelo: a FIFO só garante ordem dentro do grupo, e wallets
  diferentes têm locks diferentes. Antes era uma mensagem por vez por instância.
- **Ordem por wallet:** depois de uma falha numa wallet, as próximas mensagens dela no mesmo lote
  voltam para a fila em vez de passar na frente.
- **SIGTERM:** o long poll é abortado, a mensagem em andamento termina, o resto do lote volta com
  visibilidade 0 e só então o ORM e o cliente SQS fecham (`beforeApplicationShutdown`).
- `correlationId`/`causationId` dos eventos gerados = `messageId` da mensagem.

### Outbox publisher (`wallet-events.fifo`)

Cada volta em três passos curtos (claim → commit → publish → mark):

1. **Reserva (lease):** trava com `FOR UPDATE SKIP LOCKED` até 50 "cabeças" vencidas — o evento mais
   antigo ainda não publicado de cada wallet, pela ordem de `seq` —, reserva (`next_attempt_at = agora + 30 s`) até 50 eventos
   vencidos dessas wallets e **commita**. O lock dura só essa transação.
2. `SendMessageBatch` **fora de transação**, em lotes de 10 (limite do SQS), com os eventos de cada
   wallet juntos e em ordem (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`). Lotes de
   wallets diferentes saem em paralelo; lotes da mesma wallet saem em série: nenhuma conexão do pool nem
   lock fica preso enquanto o SQS responde.
3. Grava `published_at` ou o próximo retry, só se a reserva ainda for dele (`WHERE next_attempt_at =
   lease`).

- Publishers concorrentes (outras instâncias) reservam wallets disjuntas (teste com dois publishers).
- Pool próprio: o publisher usa um `MikroORM` só dele (até 2 conexões, `OUTBOX_POOL`), então sob
  saturação do HTTP não espera conexão do pool principal de 10, e não tira conexões do HTTP.
- Morreu depois de publicar e antes de marcar: a reserva vence em 30 s e o lote é republicado com o
  mesmo `eventId`. A FIFO descarta a duplicata dentro de 5 min; depois disso, o consumidor deduplica
  por `eventId`. Publisher lento que perdeu a reserva não sobrescreve quem a pegou.
- Antes (até a migration 5) o lote ficava travado na transação durante a chamada ao SQS, até 10 s;
  sob carga isso disputava o pool com o HTTP (lag de até ~12 s medido).
- SQS fora ou lento (timeout de 10 s): o lote inteiro vai para o backoff da outbox (1s, 2s… até 5 min),
  contado a partir do fim da chamada. Sem limite de tentativas: um evento nunca é descartado.
  O prazo é um `Promise.race` contra o `AbortSignal`: no Bun, o SDK não derruba o socket pendurado
  quando o signal dispara, e a chamada ficava presa até o `requestTimeout` de 30 s (que, sem
  `throwOnRequestTimeout`, só gerava aviso). Se a chamada abandonada ainda publicar, o retry vira
  duplicata segura (mesmo `MessageDeduplicationId`). Teste: SQS que aceita a conexão e nunca responde.
- Busca das vencidas pelo índice parcial `outbox_due_idx (next_attempt_at, occurred_at, id) WHERE
  published_at IS NULL`: com o SQS fora, as pendentes em backoff não são lidas a cada volta.
- **Ordem por wallet é estrita, e não depende de relógio.** A ordem é a de `outbox_messages.seq`, uma
  sequência do banco (identity) sorteada no INSERT do evento. O INSERT acontece com a wallet travada
  (`FOR UPDATE`), então o evento seguinte da mesma wallet só é gravado depois do commit do anterior e recebe
  um `seq` maior, mesmo vindo de outra instância com o relógio atrasado. `occurred_at` (relógio do app) fica
  só no envelope e na métrica de lag; ordenar por ele quebrava a ordem com relógios divergentes ou com dois
  eventos no mesmo milissegundo em processos diferentes (UUIDv7 só é monotônico dentro do processo). Teste:
  eventos gravados com `occurred_at` decrescente saem do claim na ordem de gravação (`schema.test.ts`).
  Uma wallet só entra numa reserva se a cabeça dela estiver vencida e
  livre; enquanto um publisher tem a cabeça (reservada, ou em backoff depois de uma recusa), nenhum outro
  pega eventos posteriores da mesma wallet. Na volta, uma recusa do SQS segura o resto da série daquela
  wallet (vai junto para o retry). Única brecha: o SQS recusar uma entrada no meio de um lote e aceitar as
  seguintes da mesma wallet no mesmo lote. A garantia final continua no banco (§8: a ordem do broker é
  otimização), e o consumidor deduplica por `eventId`. Teste: dois publishers, wallets com mais de um
  lote de eventos, e a ordem de chegada na FIFO bate com a ordem de gravação na outbox (`seq`).

### Referências fora de ordem (§7.1)

O worker reserva até 20 PENDING_REFERENCE vencidas e reavalia cada uma com as mesmas regras
(`applyWager`), sob o lock da wallet. A reserva é um `UPDATE … WHERE id IN (SELECT … FOR NO KEY UPDATE
SKIP LOCKED)` que empurra `next_reference_attempt_at` para daqui a 2 min: instâncias concorrentes pegam
linhas diferentes, e uma instância que morre no meio solta as linhas sozinha quando a reserva vence
(sem gastar tentativa). A linha é relida dentro do lock da wallet e só é tratada se a reserva ainda é
desta volta.

- Backoff: 1s, 2s, 4s… até 60s entre tentativas (`reference_attempts`, `next_reference_attempt_at`).
- **Limite: 10 tentativas (~4 min).** Reversão antes da aposta é corrida entre mensagens em voo e
  se resolve em segundos; minutos depois, a referência não vem mais e o provedor precisa saber.
  Esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_PROCESSED`, se a referência
  existe mas nunca foi aplicada) e evento `WagerTransactionRejected`.
- Resolvida: lançamento, saldo, `observed_balance` e eventos, como uma transação nova.
- Erro transitório (banco fora, lock timeout): a linha é adiada 60 s sem gastar tentativa, e as
  outras seguem. Erro não transitório (bug): gasta tentativa; esgotadas, `FAILED` + `INTERNAL_ERROR`
  e evento `WagerTransactionFailed` (ver Códigos de falha).
- O `correlationId` de quem enviou fica gravado na transação (`correlation_id`, migration 6): os
  eventos e o log do worker usam o mesmo id da requisição/mensagem original. Linhas anteriores à
  migration (sem ele) usam o id da transação.

## Teste de carga

`bun run test:load` (`test/load/run.ts`, precisa do `infra:up`). Ele é autocontido como a suíte de
concorrência:

- Recria o banco `wagering_test_load` e cria filas FIFO próprias.
- Sobe 3 processos do app com os workers ligados, então consumer, publisher e worker de referências
  rodam de verdade e o outbox lag medido é real.

**Metodologia.**

- Abre 200 wallets e 1 hot wallet, todas com saldo alto: a carga mede processamento, não esgota
  saldo.
- Espera a outbox drenar e então roda N clientes em loop fechado por 30s. Cada requisição vai para
  uma instância sorteada.
- Mistura de requisições: 55% BET 1.00 em wallet sorteada, 5% BET maior que qualquer saldo (caminho
  de rejeição: tem que voltar 422 `INSUFFICIENT_FUNDS`, senão o script falha), 15% BET na hot wallet, 10% WIN e 15%
  reenvio de uma requisição já feita (replay).
- Latência medida no cliente, percentil nearest-rank.
- Conflitos e duplicatas: delta dos contadores do `/metrics` somado nas 3 instâncias.
- Outbox lag: o gauge `outbox_lag_seconds`, amostrado a cada 1s.
- No fim, duas conferências por wallet; se alguma falhar, o script sai com código 1:
  - reconciliação: saldo == ledger;
  - saldo final == inicial ± as respostas da primeira vez (200 aplicada, 422 rejeitada). Esta pega
    débito duplicado ou perdido, que a reconciliação sozinha não veria (saldo e ledger andam juntos).
    Wallet com resposta 5xx ou de rede fica fora desta conferência, porque não dá para saber se
    a transação commitou.

**Ambiente.** Uma máquina com 16 CPUs (WSL2), Bun 1.3.13, Postgres 16 e LocalStack 4.12 no Docker.
O pool principal é de 10 conexões por instância (mais 2 do publisher, desde o pool próprio). Cliente, 3 apps, Postgres e LocalStack disputam a
mesma CPU.

**Resultado (2026-11-14):**

| | 16 clientes | 64 clientes |
|---|---|---|
| Requisições em 30s | 18.162 | 18.974 |
| Throughput | 605 req/s | 628 req/s |
| p50 / p95 / p99 | 15 / 105 / 149 ms | 66 / 329 / 444 ms |
| p50 / p99 da hot wallet | 84 / 204 ms | 263 / 537 ms |
| Erros (5xx + rede) | 0% | 0% |
| Conflitos de lock (timeout/deadlock) | 0 | 0 |
| Replays detectados | 2.757 | 2.813 |
| Outbox lag máx (mediana) | 0,48 s (0,1 s) | 12,0 s (6,4 s) |
| Outbox drenou depois do fim | 0,3 s | 6,9 s |
| Saldo == ledger | 201/201 | 201/201 |
| Saldo == inicial ± respostas aplicadas | 201/201 | 201/201 |

**Depois das partidas dobradas (2026-11-15, 64 clientes, mesma máquina):** 17.220 requisições, 570 req/s,
p50 / p95 / p99 de 77 / 364 / 485 ms, hot wallet p50 / p99 de 301 / 618 ms, 0% de erro, 0 conflitos de
lock, outbox lag máx 11,7 s (mediana 7,0 s), 201/201 reconciliadas e com saldo == respostas. Cerca de 9%
menos vazão que a medição anterior, coerente com os 2 inserts a mais por movimento dentro do lock — mas
é uma execução de cada lado, então a diferença não está isolada de ruído.

**Depois do replay sem lock e dos triggers de saldo == ledger (2026-11-15, 64 clientes, mistura nova com 5% de BET rejeitada):**
16.300 requisições, 536 req/s, p50 / p95 / p99 de 75 / 418 / 613 ms, 0% de erro, 0 conflitos de lock,
819/819 rejeições esperadas voltaram 422 (nenhuma fora do esperado), 201/201 reconciliadas e com saldo ==
respostas. Replays: p95 199 ms contra 640 ms da hot wallet — o replay sem lock deixou de pegar a fila
dela. Outbox lag máx 18,1 s (mediana 7,8 s), drenou em 10 s. A vazão caiu de novo (~6%), coerente com os
triggers de saldo == ledger e as leituras a mais (replay antes do lock, "já revertida"); o lag não
melhorou com o lease: o gargalo é o mesmo pool de 10 conexões disputado com o HTTP, não o lock durante
o envio. Uma execução de cada lado: as diferenças de 628 → 570 → 536 não estão isoladas de ruído.

**Código atual (2026-11-15, 64 clientes, mesma máquina; publisher com reserva de 50, pool próprio e
ordem estrita por wallet):** 13.309 requisições, 439 req/s, p50 / p95 / p99 de 96 / 514 / 721 ms, hot
wallet p50 / p99 de 427 / 881 ms, 0% de erro, 0 conflitos de lock, 657/657 rejeições esperadas voltaram
422, 1.971 replays, **outbox lag máx 0,65 s (mediana 0,2 s)**, drenou 0,3 s depois do fim, 201/201
reconciliadas e com saldo == respostas. O lag caiu de 18,1 s para 0,65 s: o publisher deixou de disputar
o pool do HTTP. A vazão menor (536 → 439) vem junto com mais carga concorrente na máquina (outros
containers locais rodando); uma execução de cada lado, sem isolar ruído.

**Análise.**

- **O teto é ~600 req/s nesta máquina.** De 16 para 64 clientes a vazão não muda, só a fila cresce
  e a latência quadruplica. Com tudo na mesma máquina, não dá para separar quanto do teto é CPU,
  pool (10 conexões por instância) ou Postgres. Medir isso exigiria cliente e banco em máquinas
  separadas.
- **Hot wallet.** As transações da mesma wallet são serializadas pelo lock. Os ~90 a 95 por segundo
  que ela recebeu são só a fatia de 15% da mistura, não um teto medido (para medir o teto, seria
  preciso um cenário só de hot wallet). O que o teste mostra é a latência dela: cresce com a
  disputa (p50 de 84 para 263 ms), mas nenhuma estourou o `lock_timeout` de 5s. É a troca
  escolhida: correção acima de vazão.
- **Replays eram decididos sob o lock da wallet** (p95 dos replays subia com a hot wallet). Agora
  o replay de transação terminal sai sem o lock (passo 0 do processamento); ver o resultado abaixo.
- **Outbox lag sob saturação.** Com 16 clientes, o evento sai em menos de 1s. Com 64, o publisher
  (na época, lotes de 10, um por vez, por instância) disputava o mesmo pool com as requisições HTTP e
  ficava para trás: até ~12s (18 s na última rodada), e drenava em ~7s quando a carga parava. Nenhum
  evento se perde, só atrasa. Feito depois: reserva de 50 por volta (5× menos idas ao banco por evento)
  e pool próprio para o publisher. Na rodada do código atual o lag máximo foi 0,65 s com 64 clientes.
- **Correção sob carga.** Zero 5xx, todas as wallets reconciliadas com o ledger e com o saldo
  exato que as respostas prometeram: nenhum débito duplicado ou perdido.

Limites do experimento:

- LocalStack não é SQS real: latência e throttling são outros.
- A carga entra só por HTTP. O consumer SQS usa o mesmo use case, mas a vazão dele não foi medida;
  a fila participa só pelo publisher da outbox.
- Rodadas de 30s não mostram efeitos de longo prazo (bloat, autovacuum, crescimento do ledger).
- Cada cenário rodou uma vez.

## Interpretações das regras de negócio

### REFUND e ROLLBACK na mesma aposta: uma reversão só

> 3. `REFUND` só referencia `BET`. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`.
> 4. Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.

Lida sozinha, a regra 4 impede dois REFUNDs ou dois ROLLBACKs da mesma aposta, mas não um REFUND
seguido de um ROLLBACK — e os dois podem apontar para uma `BET`:

```
BET      -80.00   saldo  20.00
REFUND   +80.00   saldo 100.00   (devolve a aposta)
ROLLBACK +80.00   saldo 180.00   (devolve a mesma aposta de novo)
```

**O que está implementado:** cada transação tem **no máximo uma reversão PROCESSED, de qualquer
tipo**. O segundo reverso (de qualquer tipo) é `REJECTED` com `REFERENCE_ALREADY_REVERSED`. No banco,
índice único parcial em `(reference_transaction_id)`; no domínio, `referenceFailure` recebe "já
revertida" sem olhar o tipo.

**Por quê, pelo próprio enunciado:** a tabela do §7 diz que REFUND e ROLLBACK revertem a referência
"uma única vez", e o §3 diz que o sistema não pode duplicar créditos. A regra 4 proíbe o mesmo tipo
duas vezes, mas não autoriza tipos diferentes; aceitar os dois devolveria a aposta duas vezes,
contra o §3. A leitura "uma reversão por referência" cumpre as três frases ao mesmo tempo. (A
primeira versão implementou a leitura literal da regra 4; um teste mostrou o crédito duplo,
150 → 180, e a correção entrou na migration 6.)

Consequências:

- ROLLBACK de um REFUND continua valendo: a referência é o REFUND, não a BET (desfaz o reembolso).
- Depois disso, a BET original **não** pode ser reembolsada de novo: ela já teve uma reversão
  PROCESSED. Conservador de propósito (nunca credita duas vezes); um novo reembolso legítimo seria
  uma operação manual.

### WIN ou LOSS sobre uma aposta já devolvida

O desafio não diz o que fazer com um `WIN` referenciando uma `BET` já reembolsada ou desfeita. Pela
mesma lógica (§3), prêmio sobre aposta cancelada não é pago: `WIN`/`LOSS` cuja BET referenciada já
tem reversão PROCESSED é `REJECTED` com `REFERENCE_ALREADY_REVERSED`. Só no domínio (regra entre
linhas); o lock da wallet serializa WIN e REFUND da mesma wallet, então não há corrida. `WIN` sem
referência não tem como ser checado e é pago (a referência é opcional no WIN).

## Limitações conhecidas

- LocalStack fixado em 4.12: a imagem `latest` passou a exigir auth token (2026.03.0).
- Postgres exposto na porta 5434 do host (5432/5433 costumam estar ocupadas), só em `127.0.0.1`.
- O container roda `bun src/main.ts` direto: via `bun run` o SIGTERM terminava em crash (exit 139).
- Uma wallet muito disputada vira fila no lock: a latência das transações novas cresce com a disputa
  (correção acima de vazão). Replays de transações já decididas não entram nessa fila.
- PENDING_REFERENCE resolve no ritmo do backoff (até 60s depois da referência chegar), não no
  instante em que ela chega.
- A migration 2 preenche `wallet_version` e `observed_balance` das linhas antigas a partir do
  ledger; transações antigas sem lançamento (LOSS/REJECTED) ficam sem saldo observado, por isso a
  regra entrou como `NOT VALID` (vale para linhas novas). O replay de uma dessas linhas antigas
  responde 500 em vez de inventar um saldo: num banco criado do zero (o caso da entrega) elas não existem.
- A migration 6 não cria o índice de "uma reversão por referência" num banco que já tenha REFUND +
  ROLLBACK da mesma BET (falha de propósito: é crédito duplicado para auditar à mão).
- Reconciliação soma créditos e débitos de toda a vida da wallet: acima de 10^18 de movimento
  acumulado a soma não cabe no `Money` (limite de `NUMERIC(20,2)`). Do mesmo jeito, um crédito que
  levaria o saldo a 10^18 sai como `INVALID_MONEY` (400 / DLQ), não como rejeição gravada.
- `consumer_message_failures`: a linha de uma mensagem é apagada quando ela tem desfecho (ack ou DLQ).
  A limpeza é melhor esforço: se o banco cair bem nesse instante, sobra uma linha órfã (só ocupa
  espaço; limpar por `last_failed_at` se um dia crescer).
- A auditoria periódica varre o banco inteiro (agregação do ledger e das partidas) a cada 5 min em
  cada instância, com `statement_timeout` de 30 s. Com um ledger muito grande, o próximo passo é
  varrer por lotes de wallets ou só wallets alteradas desde a última volta.
- Com o Postgres fora, o consumer não consegue contar falhas e volta a usar o `ApproximateReceiveCount`
  (o comportamento antigo, sem o desconto das mensagens só devolvidas). O orçamento transitório (9) segura
  ~3 min de queda; acima disso a mensagem vai para a DLQ e precisa de redrive manual.
