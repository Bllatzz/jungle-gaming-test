import { MikroORM, UniqueConstraintViolationException } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { UniqueViolationError } from '../../application/errors';
import { type WagerStore, UnitOfWork } from '../../application/ports';
import { Metrics } from '../observability/metrics';
import { lockConflict, violatedConstraint } from './transient-errors';
import { WagerRepository } from './wager.repository';

/** UnitOfWork sobre em.transactional() do MikroORM: o WagerRepository recebe o EntityManager da transação. */
@Injectable()
export class MikroUnitOfWork extends UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
  ) {
    super();
  }

  async transaction<T>(work: (store: WagerStore) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional((em) => work(new WagerRepository(em)));
    } catch (error) {
      // conflito de lock é detalhe do Postgres: contado aqui, para qualquer use case
      const conflict = lockConflict(error);
      if (conflict) this.metrics.inc('wager_lock_conflicts_total', { type: conflict });
      if (error instanceof UniqueConstraintViolationException) throw new UniqueViolationError(violatedConstraint(error), { cause: error });
      throw error;
    }
  }
}
