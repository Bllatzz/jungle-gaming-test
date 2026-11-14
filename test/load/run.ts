import type { Subprocess } from 'bun';
import { join } from 'node:path';
import { openWallet, reconcile, wagerPayload, type TestWallet } from '../support/api-client';
import { freshTestDatabase } from '../support/test-database';
import { freshTestQueues } from '../support/test-queues';

/**
 * Teste de carga (`bun run test:load`, exige `infra:up`): 3 processos do app com workers ligados, banco e filas
 * próprios, carga mista em loop fechado. Imprime o relatório e sai com 1 se alguma wallet não reconciliar.
 */

const positiveInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} precisa ser inteiro positivo`);
  return value;
};
const CONCURRENCY = positiveInt('LOAD_CONCURRENCY', 64);
const DURATION_MS = positiveInt('LOAD_DURATION_S', 30) * 1_000;
const WALLETS = positiveInt('LOAD_WALLETS', 200);
const PORTS = [39201, 39202, 39203];
const urls = PORTS.map((p) => `http://localhost:${p}`);

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;

type Sample = { op: string; status: number; ms: number };

async function main() {
  const queues = await freshTestQueues(await freshTestDatabase('load', true), 'load', 30);
  const { env } = queues;
  const instances: Subprocess[] = PORTS.map((port) =>
    Bun.spawn(['bun', join(import.meta.dir, '../../src/main.ts')], {
      env: {
        ...process.env, PORT: String(port), DATABASE_URL: env.databaseUrl, WORKERS_ENABLED: 'true',
        SQS_WAGER_QUEUE: env.queues.wager, SQS_WAGER_DLQ: env.queues.wagerDlq, SQS_EVENTS_QUEUE: env.queues.events,
      },
      stdout: 'ignore', // logs JSON de cada transação: o relatório vem das métricas
      stderr: 'inherit',
    }),
  );
  try {
    for (const u of urls) await waitUntilReady(u);
    const report = await run();
    console.log(report.text);
    if (!report.consistent) process.exitCode = 1;
  } finally {
    for (const p of instances) p.kill('SIGTERM');
    const killer = setTimeout(() => instances.forEach((p) => p.kill('SIGKILL')), 15_000); // shutdown travado não pendura o script
    await Promise.all(instances.map((p) => p.exited));
    clearTimeout(killer);
    await queues.cleanup();
  }
}

async function run() {
  // saldo alto: a carga mede o processamento, não esgota wallets (rejeição por saldo é decisão, não erro)
  const wallets: TestWallet[] = [];
  for (let i = 0; i < WALLETS; i += 20) {
    wallets.push(...await Promise.all(Array.from({ length: Math.min(20, WALLETS - i) }, () => openWallet(pick(urls), '100000.00'))));
  }
  const hot = await openWallet(urls[0]!, '100000.00');
  await waitOutboxDrained(); // eventos de abertura fora da medição

  const before = await counters();
  const sent: Record<string, any>[] = [];
  // saldo esperado de cada wallet, em centavos, pelas respostas da primeira vez (200 = aplicada, 422 = rejeitada).
  // Resposta 5xx/rede: não dá para saber se commitou, a wallet sai da conferência exata (fica só a reconciliação).
  const expectedCents = new Map<string, number>();
  const uncertain = new Set<string>();
  const samples: Sample[] = [];
  // NaN = amostra perdida (/metrics omite o gauge se a consulta passar de 2s): contada no relatório, não escondida
  const lag: number[] = [];
  let sampling = true;
  const sampler = setInterval(async () => {
    const value = (await scrape(urls[0]!).catch(() => undefined))?.value('outbox_lag_seconds') ?? NaN;
    if (sampling) lag.push(value);
  }, 1_000);

  const startedAt = performance.now();
  const deadline = startedAt + DURATION_MS;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (performance.now() < deadline) {
      const roll = Math.random();
      const [op, payload] =
        roll < 0.6 ? ['bet', wagerPayload(pick(wallets), 'BET', '1.00')]
        : roll < 0.75 ? ['hot_bet', wagerPayload(hot, 'BET', '1.00')]
        : roll < 0.85 ? ['win', wagerPayload(pick(wallets), 'WIN', '1.00')]
        : sent.length > 0 ? ['replay', pick(sent)] : ['bet', wagerPayload(pick(wallets), 'BET', '1.00')];
      const t0 = performance.now();
      const status = await post(pick(urls), payload); // 0 = falha de rede
      samples.push({ op, status, ms: performance.now() - t0 });
      if (op === 'replay') continue;
      if (status === 200) {
        const cents = payload.kind === 'BET' ? -100 : 100;
        expectedCents.set(payload.walletId, (expectedCents.get(payload.walletId) ?? 0) + cents);
      }
      if (status === 200 || status === 422) sent.push(payload); // replay só do que já foi decidido
      else uncertain.add(payload.walletId);
    }
  }));
  const elapsedS = (performance.now() - startedAt) / 1_000;
  clearInterval(sampler);
  sampling = false;

  const drainStart = performance.now();
  await waitOutboxDrained();
  const drainS = (performance.now() - drainStart) / 1_000;
  const after = await counters();

  // invariante (saldo == ledger) e, além dela, saldo == inicial ± o que as respostas disseram (pega débito duplicado ou perdido)
  const checks = await Promise.all([...wallets, hot].map(async (w) => {
    const rec = await reconcile(pick(urls), w.id).catch(() => undefined);
    const expected = (10_000_000 + (expectedCents.get(w.id) ?? 0)) / 100;
    return {
      consistent: rec?.consistent === true,
      balanceMatches: uncertain.has(w.id) || (rec !== undefined && Number(rec.storedBalance.amount) === expected),
    };
  }));
  const inconsistent = checks.filter((c) => !c.consistent).length;
  const mismatched = checks.filter((c) => !c.balanceMatches).length;

  return {
    consistent: inconsistent === 0 && mismatched === 0,
    text: format({ samples, elapsedS, lag, drainS, before, after, inconsistent, mismatched, uncertain: uncertain.size, walletCount: checks.length }),
  };
}

function format(r: {
  samples: Sample[]; elapsedS: number; lag: number[]; drainS: number; inconsistent: number; mismatched: number; uncertain: number; walletCount: number;
  before: Record<string, number>; after: Record<string, number>;
}): string {
  const delta = (name: string) => (r.after[name] ?? 0) - (r.before[name] ?? 0);
  const byStatus = countBy(r.samples, (s) => String(s.status));
  const errors = r.samples.filter((s) => s.status === 0 || s.status >= 500).length;
  const lags = r.lag.filter(Number.isFinite);
  const ops = Object.entries(countBy(r.samples, (s) => s.op)).map(([op, n]) => {
    const ms = r.samples.filter((s) => s.op === op).map((s) => s.ms);
    return `| ${op} | ${n} | ${pct(ms, 50)} | ${pct(ms, 95)} | ${pct(ms, 99)} |`;
  });
  const all = r.samples.map((s) => s.ms);
  return [
    `## Resultado (${new Date().toISOString()})`,
    '',
    `Ambiente: ${PORTS.length} processos do app, ${CONCURRENCY} clientes concorrentes, ${(r.elapsedS).toFixed(1)}s, ` +
      `${r.walletCount - 1} wallets + 1 hot wallet, Bun ${Bun.version}, ${navigator.hardwareConcurrency} CPUs (cliente e servidores na mesma máquina).`,
    '',
    `- Requisições: ${r.samples.length} (${(r.samples.length / r.elapsedS).toFixed(0)} req/s)`,
    `- Latência (ms, cliente): p50 ${pct(all, 50)} · p95 ${pct(all, 95)} · p99 ${pct(all, 99)} · máx ${pct(all, 100)}`,
    `- Status HTTP: ${Object.entries(byStatus).map(([s, n]) => `${s === '0' ? 'rede' : s}=${n}`).join(', ')}`,
    `- Taxa de erro (5xx + rede): ${((errors / r.samples.length) * 100).toFixed(2)}%`,
    `- Conflitos de lock (lock_timeout/deadlock/corrida de idempotência): ${delta('wager_lock_conflicts_total')}`,
    `- Duplicatas detectadas (replays): ${delta('wager_duplicates_total')}`,
    `- Retries da outbox: ${delta('wager_retries_total{component="outbox"}')}`,
    `- Outbox lag durante a carga: máx ${lags.length ? Math.max(...lags).toFixed(2) : 'n/a'}s, ` +
      `mediana ${lags.length ? pct(lags, 50) : 'n/a'}s (${r.lag.length - lags.length}/${r.lag.length} amostras perdidas); ` +
      `drenou ${r.drainS.toFixed(1)}s depois do fim`,
    `- Reconciliação (saldo == ledger): ${r.walletCount - r.inconsistent}/${r.walletCount} wallets consistentes`,
    `- Saldo final == inicial ± respostas aplicadas: ${r.walletCount - r.mismatched}/${r.walletCount} wallets` +
      (r.uncertain ? ` (${r.uncertain} sem conferência exata: tiveram 5xx/rede)` : ''),
    '',
    '| Operação | Requisições | p50 ms | p95 ms | p99 ms |',
    '|---|---|---|---|---|',
    ...ops,
  ].join('\n');
}

/** Percentil nearest-rank. */
function pct(values: number[], p: number): string {
  if (values.length === 0) return 'n/a';
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!.toFixed(1);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

/** Só o status: corpo que não é JSON (502 de proxy, página de erro) não vira "falha de rede". */
async function post(baseUrl: string, payload: Record<string, any>): Promise<number> {
  try {
    const res = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `${payload.providerId}:${payload.externalTransactionId}` },
      body: JSON.stringify(payload),
    });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0;
  }
}

async function scrape(base: string) {
  const text = await (await fetch(`${base}/metrics`)).text();
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  return {
    lines,
    value: (series: string) => Number(lines.find((l) => l.startsWith(`${series} `))?.slice(series.length + 1) ?? NaN),
  };
}

/** Contadores (_total) somados nas instâncias (cada uma tem o seu registro): por nome e por série com labels. */
async function counters(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const u of urls) {
    for (const line of (await scrape(u)).lines.filter((l) => /^\w+_total[{ ]/.test(l))) {
      const [series, raw] = [line.slice(0, line.lastIndexOf(' ')), Number(line.slice(line.lastIndexOf(' ') + 1))];
      const name = series.split('{')[0]!;
      out[series] = (out[series] ?? 0) + raw;
      if (series !== name) out[name] = (out[name] ?? 0) + raw;
    }
  }
  return out;
}

async function waitOutboxDrained(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await scrape(urls[0]!).catch(() => undefined))?.value('outbox_pending_messages') === 0) return;
    await Bun.sleep(250);
  }
  throw new Error('outbox não drenou');
}

async function waitUntilReady(baseUrl: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (await fetch(`${baseUrl}/health/ready`).then((r) => r.ok, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`${baseUrl} não ficou pronto`);
}

await main();
