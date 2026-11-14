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

## Múltiplas instâncias

```bash
docker compose up -d --build --wait --scale app=3
# as réplicas ocupam as portas 3000, 3001 e 3002 (o Docker escolhe qual réplica fica em qual)
```

O serviço `migrate` roda as migrations uma única vez antes das réplicas subirem.
A faixa de portas suporta até 3 réplicas; para mais, amplie `ports` do serviço `app`.

## Scripts

| Script | Faz |
|---|---|
| `infra:up` / `infra:down` | Sobe Postgres + LocalStack / derruba tudo e apaga volumes |
| `start` / `start:dev` | Sobe o app / com reload automático |
| `typecheck` | Checagem de tipos (TypeScript strict) |
| `migration:create` / `migration:up` / `migration:down` | Cria / aplica / reverte migrations. Migration nova precisa ser registrada em `src/infrastructure/persistence/migrations/index.ts` |
| `test` | Testes de unidade (sem containers) |
| `test:integration` | Testes de integração (exige `infra:up`) |
| `test:concurrency` | Testes de concorrência (exige `infra:up`) |

## Observações

- O LocalStack está fixado em `4.12`: a imagem `latest` passou a exigir auth token.
- O Postgres usa a porta **5434** do host para não colidir com instalações locais.
