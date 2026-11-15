# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de
provedores de jogos, por HTTP e SQS, com idempotência persistente, ledger imutável e correção
sob múltiplas instâncias. Desafio técnico Jungle Gaming.

Decisões e trade-offs: [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- [Bun](https://bun.sh) 1.3+
- Docker com Compose v2

Nada roda sob Node: runtime, testes, migrations e typecheck usam Bun.

## Setup

```bash
cp .env.example .env
bun install
bun run infra:up        # Postgres (porta 5434) + LocalStack (4566) com as 3 filas
bun run migration:up
bun run start:dev       # http://localhost:3000
```

Verificação rápida:

```bash
curl localhost:3000/health/live    # {"status":"ok"}
curl localhost:3000/health/ready   # {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

Observabilidade: logs em JSON no stdout e métricas Prometheus em `curl localhost:3000/metrics`
(lista em [ARCHITECTURE.md](ARCHITECTURE.md#logs-e-métricas)).

## API

```bash
# abrir wallet
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# enviar uma aposta (troque <walletId>)
curl -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1","walletId":"<walletId>",
       "roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

| Endpoint | |
|---|---|
| `POST /wallets` | Abre wallet (saldo inicial gera transação OPENING + lançamento; header `Idempotency-Key` opcional torna o reenvio seguro) |
| `GET /wallets/:walletId` | Saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | Histórico paginado |
| `POST /wallets/:walletId/reconciliation` | Saldo gravado × ledger |
| `POST /wagering/transactions` | BET, WIN, LOSS, REFUND, ROLLBACK (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Transação pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Transação pelo id do provider |

Status HTTP de cada situação: [ARCHITECTURE.md](ARCHITECTURE.md#api-http).

## Pela fila

O app consome `wager-transactions.fifo` com o mesmo use case da API. Mensagem no formato do desafio:

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"tx-2","idempotencyKey":"provider-a:tx-2",
    "playerId":"player-1","walletId":"<walletId>","roundId":"round-1","gameId":"fortune-chimp",
    "kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

Mensagens que nunca vão dar certo vão para `wager-transactions-dlq.fifo` com o atributo `errorCode`.
Os eventos de integração (outbox) saem em `wallet-events.fifo`. `WORKERS_ENABLED=false` sobe só a API.

## Múltiplas instâncias

```bash
docker compose up -d --build --wait --scale app=3
# as réplicas ocupam as portas 3000, 3001 e 3002 (o Docker escolhe qual réplica fica em qual)
```

O serviço `migrate` roda as migrations uma única vez antes das réplicas subirem.
A faixa de portas suporta até 3 réplicas; para mais, amplie `ports` do serviço `app`.

## Autenticação (opcional)

Desligada por padrão. Para ligar, suba o Keycloak (realm `wagering` importado, um client OIDC por
provedor: `provider-a` e `provider-b`, segredo `<client>-secret`) e descomente `AUTH_ISSUER` e
`AUTH_JWKS_URL` no `.env`:

```bash
docker compose --profile auth up -d --wait keycloak     # http://localhost:8180 (admin/admin)
TOKEN=$(curl -s -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret \
  localhost:8180/realms/wagering/protocol/openid-connect/token | jq -r .access_token)
curl localhost:3000/wallets/<walletId> -H "authorization: Bearer $TOKEN"
```

Com auth ligada, rotas de wallets e transações exigem `Authorization: Bearer`; o `providerId` do body ou
da rota tem que ser o do token (senão 403). Health e `/metrics` ficam abertos. No compose, o app dentro
do container busca a JWKS pelo nome do serviço:

```bash
AUTH_ISSUER=http://localhost:8180/realms/wagering \
AUTH_JWKS_URL=http://keycloak:8080/realms/wagering/protocol/openid-connect/certs \
docker compose --profile auth up -d --build --wait --scale app=3
```

## Dashboard (opcional)

```bash
docker compose --profile observability up -d --wait    # Prometheus :9090, Grafana http://localhost:3003, Jaeger http://localhost:16686
```

Para os traces, suba o app com `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (no host) ou
`http://jaeger:4318` (no compose): span por requisição e por mensagem, com o `traceparent` viajando
pela outbox e pelo SQS.

O Prometheus raspa as réplicas do compose (DNS do Docker, uma por réplica) e também o app rodando no
host (`start:dev` na 3000 e os processos do `test:load`). O Grafana abre direto no dashboard
"Wagering Processor": transações por status, latência p50/p95/p99, outbox lag e pendentes, duplicatas,
conflitos de lock, retries, DLQ e divergências de reconciliação.

## Scripts

| Script | Faz |
|---|---|
| `infra:up` / `infra:down` | Sobe Postgres + LocalStack / derruba tudo e apaga volumes |
| `start` / `start:dev` | Sobe o app / com reload automático |
| `typecheck` | Checagem de tipos (TypeScript strict) |
| `lint` | Typecheck com as checagens extras do compilador: import/variável/parâmetro sem uso, `switch` sem `break`, caminho sem `return`, `override` explícito, código inalcançável |
| `migration:create` / `migration:up` / `migration:down` | Cria / aplica / reverte migrations (descobertas pelo nome do arquivo; `up`/`down` concorrentes esperam um advisory lock) |
| `test` | Testes de unidade (sem containers) |
| `test:integration` | Testes de integração (exige `infra:up`) |
| `test:concurrency` | Testes de concorrência: 3 processos do app ao mesmo tempo, `kill -9` e SIGTERM no meio da carga, e `kill -9` exatamente entre commit e ack (via `FAULT_INJECTION=kill-after-commit`, só para teste) (exige `infra:up`) |
| `test:load` | Teste de carga: 3 processos com workers, carga mista por 30s, relatório de throughput, p50/p95/p99, erros, conflitos e outbox lag (exige `infra:up`; `LOAD_CONCURRENCY`, `LOAD_DURATION_S`, `LOAD_WALLETS`). Resultado e análise em [ARCHITECTURE.md](ARCHITECTURE.md#teste-de-carga) |

Mapa dos 8 cenários de concorrência do desafio: os itens 1 a 5, 7 e 8 estão em `test/concurrency`; o 6
(dois publishers sobre a mesma outbox) está em `test/integration/messaging.test.ts`, com dois apps e
pools separados disputando as mesmas linhas no Postgres.

Os testes de integração e concorrência criam bancos próprios (`wagering_test_<suíte>`), recriados a
cada execução, e filas FIFO próprias por execução: nunca tocam o banco nem as filas de desenvolvimento.

## Observações

- O LocalStack está fixado em `4.12`: a imagem `latest` passou a exigir auth token.
- O Postgres usa a porta **5434** do host para não colidir com instalações locais.
