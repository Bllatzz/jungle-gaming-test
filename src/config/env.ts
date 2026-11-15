/** Configuração tipada do app. Função pura: testes passam o objeto que quiserem. */
export type Env = {
  port: number;
  databaseUrl: string;
  awsRegion: string;
  awsEndpointUrl: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  queues: { wager: string; wagerDlq: string; events: string };
  /** Consumer SQS, publisher da outbox e worker de referências. false: só HTTP (testes chamam as voltas direto). */
  workersEnabled: boolean;
  /** JWT do IdP (Keycloak) nas rotas de wallets e transações. Ausente: AuthGuard deixa tudo passar. */
  auth?: { issuer: string; jwksUrl: string };
  /**
   * Só testes: `kill-after-commit` faz o consumer se matar com SIGKILL logo depois do commit e antes do ack —
   * a janela exata que a redelivery + inbox precisam cobrir. Nunca ligado em produção.
   */
  faultInjection?: 'kill-after-commit';
  /** OTLP/HTTP do coletor de traces (ex.: Jaeger). Ausente: tracing desligado. */
  otelEndpoint?: string;
};

/** Token de injeção do Nest para o objeto Env. */
export const ENV = Symbol('ENV');

export function loadEnv(source: Record<string, string | undefined>): Env {
  const required = (name: string): string => {
    const value = source[name]?.trim();
    if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
    return value;
  };

  const workers = source.WORKERS_ENABLED?.trim() || 'true';
  if (workers !== 'true' && workers !== 'false') throw new Error('Variável de ambiente inválida: WORKERS_ENABLED (true|false)');

  const rawPort = required('PORT');
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) throw new Error('Variável de ambiente inválida: PORT');

  const issuer = source.AUTH_ISSUER?.trim();
  const jwksUrl = source.AUTH_JWKS_URL?.trim();
  if (!issuer !== !jwksUrl) throw new Error('AUTH_ISSUER e AUTH_JWKS_URL vão juntas (as duas ou nenhuma)');

  const fault = source.FAULT_INJECTION?.trim() || undefined;
  if (fault !== undefined && fault !== 'kill-after-commit') throw new Error('Variável de ambiente inválida: FAULT_INJECTION (kill-after-commit)');

  return {
    port,
    databaseUrl: required('DATABASE_URL'),
    awsRegion: required('AWS_REGION'),
    awsEndpointUrl: required('AWS_ENDPOINT_URL'),
    awsAccessKeyId: required('AWS_ACCESS_KEY_ID'),
    awsSecretAccessKey: required('AWS_SECRET_ACCESS_KEY'),
    queues: {
      wager: required('SQS_WAGER_QUEUE'),
      wagerDlq: required('SQS_WAGER_DLQ'),
      events: required('SQS_EVENTS_QUEUE'),
    },
    workersEnabled: workers === 'true',
    auth: issuer && jwksUrl ? { issuer, jwksUrl } : undefined,
    faultInjection: fault,
    otelEndpoint: source.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined,
  };
}
