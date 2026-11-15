import { Migration } from '@mikro-orm/migrations';

/**
 * Contexto de trace (W3C traceparent) de quem gravou o evento: o publisher o repassa como atributo da mensagem
 * SQS, e o trace da transação continua no consumidor do evento. Nulo com o tracing desligado.
 */
export class Migration20261115120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table outbox_messages add column traceparent text;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table outbox_messages drop column traceparent;`);
  }
}
