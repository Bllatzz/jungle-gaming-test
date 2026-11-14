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
  };
}
