-- Roles do banco. Roda no init de um volume novo e de novo a cada `bun run infra:up` / `docker compose up`
-- (serviço `roles`): idempotente, então um volume antigo ganha os roles sem ser recriado.
-- O role de grupo recebe os grants nas migrations (Migration20261115130000 e seguintes); o login do app só
-- herda dele e não é dono de nenhuma tabela. Senha de dev local, igual às demais do compose.
do $$ begin
  if not exists (select from pg_roles where rolname = 'wagering_runtime') then
    create role wagering_runtime nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'wagering_app') then
    create role wagering_app login password 'wagering_app' in role wagering_runtime;
  end if;
end $$;
