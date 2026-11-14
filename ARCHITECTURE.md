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
do banco — inbox persistente e constraints de unicidade *(planejado — partes 3 e 5)*.
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

## Limitações conhecidas

- LocalStack fixado em 4.12: a imagem `latest` passou a exigir auth token (2026.03.0).
- Postgres exposto na porta 5434 do host (5432/5433 costumam estar ocupadas), só em `127.0.0.1`.
- Migrations sem lock: a garantia de execução única vem do serviço `migrate` do compose. Rodar
  `migration:up` de vários lugares ao mesmo tempo não é seguro.
- O container roda `bun src/main.ts` direto: via `bun run` o SIGTERM terminava em crash (exit 139).
