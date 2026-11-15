import DecimalBase from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

// Instância própria com precisão folgada: somas e subtrações de 2 casas nunca arredondam.
const Decimal = DecimalBase.clone({ precision: 40 });
type Decimal = InstanceType<typeof Decimal>;

// Escala fixa: até 18 dígitos inteiros e exatamente 2 decimais (cabe em NUMERIC(20,2)). Sem sinal, espaço, expoente ou zero à esquerda.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const STORAGE_LIMIT = new Decimal('1e18');

/** Formato de dinheiro nos contratos (HTTP, SQS, eventos). */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Valor monetário imutável, sempre com 2 casas. Toda operação devolve uma nova instância. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Contrato de entrada: exige "0.00" (escala fixa de 2 casas); rejeita negativos e qualquer formato ambíguo. */
  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`Valor monetário inválido: ${JSON.stringify(props?.amount)}`);
    }
    return new Money(new Decimal(props.amount), Money.validCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.validCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  /** Cabe em NUMERIC(20,2): até 18 dígitos inteiros. */
  fitsStorage(): boolean {
    return this.value.abs().lessThan(STORAGE_LIMIT);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Moedas diferentes não são iguais (não lança: igualdade é uma pergunta, não uma operação). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`Moedas diferentes: ${this.currency} e ${other.currency}`);
    }
  }

  private static validCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Moeda inválida: ${JSON.stringify(currency)}`);
    }
    return currency;
  }
}
