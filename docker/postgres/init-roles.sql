-- Roda uma vez, na criação do volume. O role de grupo recebe os grants na migration
-- Migration20261115130000; o login do app só herda dele e não é dono de nenhuma tabela.
-- Senha de dev local, igual às demais do compose.
create role wagering_runtime nologin;
create role wagering_app login password 'wagering_app' in role wagering_runtime;
