import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias do domínio (§6) também vivem aqui: unicidade, saldo não-negativo,
 * ledger imutável e a regra 4 (uma reversão por tipo) — o banco é a última linha de defesa.
 * Listas de enum são literais de propósito: uma migration não pode mudar quando o código muda.
 */
export class Migration20261114120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   text           not null,
        currency    char(3)        not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20, 2) not null check (balance >= 0),
        version     integer        not null check (version >= 1),
        created_at  timestamptz    not null,
        updated_at  timestamptz    not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        -- alvo da FK composta do ledger: garante lançamento na moeda da wallet
        constraint wallets_id_currency_unique unique (id, currency)
      );`);

    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        text           not null,
        external_transaction_id            text           not null,
        idempotency_key                    text           not null,
        payload_hash                       text           not null,
        -- sem FK de moeda/player com a wallet: rejeições por CURRENCY_MISMATCH ou
        -- WALLET_PLAYER_MISMATCH precisam ficar gravadas (auditáveis)
        wallet_id                          uuid           not null references wallets (id),
        player_id                          text           not null,
        round_id                           text           not null,
        game_id                            text           not null,
        kind                               text           not null
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(20, 2) not null,
        currency                           char(3)        not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  text,
        reference_transaction_id           uuid references wager_transactions (id),
        status                             text           not null
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       text check (failure_code in (
          'INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'CURRENCY_MISMATCH', 'WALLET_PLAYER_MISMATCH',
          'REFERENCE_NOT_FOUND', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_MISMATCH', 'REFERENCE_INVALID_KIND',
          'REFERENCE_ALREADY_REVERSED', 'AMOUNT_MISMATCH', 'INTERNAL_ERROR')),
        created_at                         timestamptz    not null,
        processed_at                       timestamptz,
        constraint wager_tx_external_unique unique (provider_id, external_transaction_id),
        constraint wager_tx_idempotency_unique unique (provider_id, idempotency_key),
        constraint wager_tx_amount_check check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_tx_reference_required
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_processed_at_check check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_tx_failure_code_check check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        -- sem isso um REFUND/ROLLBACK processado com referência NULL escaparia do índice da regra 4
        -- (no Postgres, NULLs são distintos em índice único)
        constraint wager_tx_processed_reversal_has_reference
          check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null),
        constraint wager_tx_no_self_reference check (reference_transaction_id <> id),
        -- alvo da FK composta do ledger: lançamento tem a wallet, o valor e a moeda da sua transação
        constraint wager_tx_ledger_target_unique unique (id, wallet_id, amount, currency)
      );`);
    // Triggers usam o SQLSTATE padrão (P0001), não check_violation: violar uma regra de imutabilidade
    // é erro de programação, e o app consegue distinguir de um CHECK comum.
    // Regra 4: uma referência não pode ser revertida duas vezes pelo mesmo tipo.
    this.addSql(`
      create unique index wager_tx_one_reversal_per_kind
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');`);
    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id);`);
    // Referência chegando fora de ordem: busca as pendentes que esperam por (provider, id externo).
    this.addSql(`
      create index wager_tx_pending_reference_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';`);
    this.addSql(`
      create function wager_tx_terminal_is_final() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager_transaction % is terminal (%) and cannot change', old.id, old.status;
        end if;
        if tg_op = 'DELETE' then
          raise exception 'wager_transaction % cannot be deleted', old.id;
        end if;
        -- só status e campos de resultado mudam; o que entrou no payload_hash é fixo
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager_transaction % immutable fields cannot change', old.id;
        end if;
        return new;
      end $$;`);
    this.addSql(`
      create trigger wager_tx_terminal_is_final before update or delete on wager_transactions
        for each row execute function wager_tx_terminal_is_final();`);

    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        wallet_id       uuid           not null,
        transaction_id  uuid           not null,
        direction       text           not null check (direction in ('DEBIT', 'CREDIT')),
        amount          numeric(20, 2) not null check (amount > 0),
        currency        char(3)        not null,
        balance_before  numeric(20, 2) not null check (balance_before >= 0),
        balance_after   numeric(20, 2) not null check (balance_after >= 0),
        created_at      timestamptz    not null,
        -- no máximo um lançamento por transação
        constraint ledger_transaction_unique unique (transaction_id),
        -- lançamento tem a mesma wallet, valor e moeda da transação que o gerou
        constraint ledger_transaction_fk foreign key (transaction_id, wallet_id, amount, currency)
          references wager_transactions (id, wallet_id, amount, currency),
        constraint ledger_wallet_currency_fk foreign key (wallet_id, currency) references wallets (id, currency),
        constraint ledger_balanced check (
          balance_after = case direction when 'CREDIT' then balance_before + amount
                                         else balance_before - amount end)
      );`);
    // Histórico da wallet paginado por cursor (created_at, id) e reconciliação.
    this.addSql(`create index ledger_wallet_created_idx on wallet_ledger_entries (wallet_id, created_at, id);`);
    this.addSql(`
      create function ledger_is_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% blocked)', tg_op;
      end $$;`);
    this.addSql(`
      create trigger ledger_no_update_delete before update or delete on wallet_ledger_entries
        for each row execute function ledger_is_append_only();`);
    this.addSql(`
      create trigger ledger_no_truncate before truncate on wallet_ledger_entries
        for each statement execute function ledger_is_append_only();`);

    this.addSql(`
      create table inbox_messages (
        consumer_name  text        not null,
        message_id     text        not null,
        payload_hash   text        not null,
        received_at    timestamptz not null,
        processed_at   timestamptz,
        primary key (consumer_name, message_id)
      );`);

    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        aggregate_id     text        not null,
        event_type       text        not null,
        payload          jsonb       not null,
        occurred_at      timestamptz not null,
        attempts         integer     not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz,
        published_at     timestamptz
      );`);
    // Publisher busca só as pendentes, na ordem em que aconteceram.
    this.addSql(`
      create index outbox_pending_idx on outbox_messages (occurred_at)
        where published_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table outbox_messages;');
    this.addSql('drop table inbox_messages;');
    this.addSql('drop table wallet_ledger_entries;');
    this.addSql('drop function ledger_is_append_only();');
    this.addSql('drop table wager_transactions;');
    this.addSql('drop function wager_tx_terminal_is_final();');
    this.addSql('drop table wallets;');
  }
}
