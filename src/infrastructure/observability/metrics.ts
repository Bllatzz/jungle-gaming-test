import { Injectable } from '@nestjs/common';
import { type CounterName, type HistogramName, MetricsRecorder } from '../../application/ports';

/** Métricas do §12 (e a divergência do §9). Nome → ajuda; o tipo vem da lista em que está. */
const COUNTERS: Record<CounterName, string> = {
  wager_transactions_total: 'Transações decididas, por origem e status',
  wager_duplicates_total: 'Duplicatas detectadas (replay idempotente, inclusive redelivery SQS)',
  wager_conflicts_total: 'Pedidos recusados por conflito de idempotência ou de messageId',
  wager_lock_conflicts_total: 'Conflitos de concorrência: lock timeout, deadlock, corrida de idempotência',
  wager_retries_total: 'Novas tentativas agendadas, por componente',
  sqs_dead_lettered_total: 'Mensagens enviadas para a DLQ por esta instância, por motivo',
  reconciliation_divergences_total: 'Reconciliações em que o saldo gravado diverge do ledger',
};
const HISTOGRAMS: Record<HistogramName, string> = {
  wager_processing_duration_seconds: 'Latência do processamento de uma transação (inclui replay)',
};
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export type { CounterName, HistogramName };
type Labels = Record<string, string>;
type Histogram = { buckets: number[]; sum: number; count: number };

/**
 * Registro em memória, formato texto do Prometheus. Por instância: o Prometheus soma as réplicas.
 * shortcut: sem prom-client (são ~60 linhas); trocar por ele se precisar de summaries/métricas de processo.
 */
@Injectable()
export class Metrics implements MetricsRecorder {
  private readonly counters = new Map<CounterName, Map<string, number>>();
  private readonly histograms = new Map<HistogramName, Map<string, Histogram>>();

  inc(name: CounterName, labels: Labels = {}, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, number>();
    const key = labelText(labels);
    series.set(key, (series.get(key) ?? 0) + by);
    this.counters.set(name, series);
  }

  observe(name: HistogramName, labels: Labels, seconds: number): void {
    const series = this.histograms.get(name) ?? new Map<string, Histogram>();
    const key = labelText(labels);
    const h = series.get(key) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((le, i) => {
      if (seconds <= le) h.buckets[i]!++;
    });
    h.sum += seconds;
    h.count++;
    series.set(key, h);
    this.histograms.set(name, series);
  }

  /** Texto do Prometheus. `gauges`: valores lidos na hora do scrape (banco, SQS). */
  render(gauges: { name: string; help: string; value: number }[] = []): string {
    const lines: string[] = [];
    for (const [name, help] of Object.entries(COUNTERS) as [CounterName, string][]) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      for (const [labels, value] of this.counters.get(name) ?? []) lines.push(`${name}${braces(labels)} ${value}`);
    }
    for (const [name, help] of Object.entries(HISTOGRAMS) as [HistogramName, string][]) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
      for (const [labels, h] of this.histograms.get(name) ?? []) {
        // buckets do Prometheus são cumulativos: cada um conta tudo que é ≤ le (já é assim no observe)
        BUCKETS.forEach((le, i) => lines.push(`${name}_bucket${braces(join(labels, `le="${le}"`))} ${h.buckets[i]}`));
        lines.push(`${name}_bucket${braces(join(labels, 'le="+Inf"'))} ${h.count}`);
        lines.push(`${name}_sum${braces(labels)} ${h.sum}`, `${name}_count${braces(labels)} ${h.count}`);
      }
    }
    for (const g of gauges) lines.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`, `${g.name} ${g.value}`);
    return `${lines.join('\n')}\n`;
  }
}

/** Labels em ordem fixa e com escape: a mesma combinação sempre vira a mesma série. */
function labelText(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]!.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',');
}
const join = (a: string, b: string) => (a ? `${a},${b}` : b);
const braces = (labels: string) => (labels ? `{${labels}}` : '');
