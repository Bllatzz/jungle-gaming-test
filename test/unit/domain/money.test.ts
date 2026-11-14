import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from — contrato de entrada', () => {
  test('aceita até 2 casas e serializa sempre com 2', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(brl('0.01').toString()).toBe('0.01');
    expect(brl('0').toString()).toBe('0.00');
  });

  test.each([
    ['', 'vazio'], [' 10.00', 'espaço'], ['10.001', '3 casas'], ['-10.00', 'negativo'], ['+10', 'sinal'],
    ['NaN', 'NaN'], ['Infinity', 'Infinity'], ['1e3', 'notação científica'], ['010.00', 'zero à esquerda'],
    ['10.', 'ponto sem casas'], ['.50', 'sem parte inteira'], ['1,00', 'vírgula'], ['1234567890123456789', '19 dígitos'],
  ])('rejeita %p (%s)', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita moeda fora do formato ISO-4217 (3 letras maiúsculas; não valida a lista oficial)', () => {
    for (const currency of ['brl', 'BR', 'BRLL', '']) {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    }
  });

  test('rejeita amount que não é string (ex.: number vindo de JSON)', () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });
});

describe('Money — aritmética exata e imutável', () => {
  test('0.10 + 0.20 = 0.30 exatamente (sem erro de float)', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  test('subtract pode ficar negativo internamente; negate inverte', () => {
    expect(brl('10.00').subtract(brl('25.50')).toString()).toBe('-15.50');
    expect(brl('5.00').negate().toString()).toBe('-5.00');
    expect(brl('5.00').negate().isNegative()).toBe(true);
  });

  test('não arredonda valores grandes', () => {
    expect(brl('999999999999999999.99').add(brl('0.01')).toString()).toBe('1000000000000000000.00');
  });

  test('operações devolvem nova instância', () => {
    const a = brl('1.00');
    a.add(brl('2.00'));
    expect(a.toString()).toBe('1.00');
  });

  test('comparações', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.0').equals(brl('1.00'))).toBe(true);
    expect(Money.zero('BRL').equals(brl('0'))).toBe(true);
  });

  test('moedas diferentes lançam CurrencyMismatchError', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });
});
