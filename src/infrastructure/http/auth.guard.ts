import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { ENV, type Env } from '../../config/env';

/** Token emitido para outro serviço do mesmo IdP não vale aqui (mapper de audience no realm do Keycloak). */
export const AUDIENCE = 'wagering-api';

const providers = new WeakMap<Request, string>();

/** providerId do token da requisição; undefined com a auth desligada. */
export const authenticatedProvider = (req: Request): string | undefined => providers.get(req);

/**
 * Autenticação pelo IdP externo (Keycloak, ARCHITECTURE.md → Autenticação). Cada provedor de jogos é um
 * client OIDC (client credentials); o token traz o claim `provider_id`. O guard confere assinatura (JWKS do
 * IdP, com cache e rotação de chave pela própria `jose`), emissor e validade, e recusa um provedor agindo em
 * nome de outro: `providerId` do body ou da rota tem que ser o do token. Sem `env.auth`, deixa tudo passar.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.auth) this.jwks = createRemoteJWKSet(new URL(env.auth.jwksUrl));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.env.auth || !this.jwks) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const token = /^Bearer (\S+)$/i.exec(req.header('authorization') ?? '')?.[1];
    if (!token) throw new UnauthorizedException('Header Authorization: Bearer <token> ausente');

    let providerId: unknown;
    try {
      const { payload } = await jwtVerify(token, this.jwks, { issuer: this.env.auth.issuer, audience: AUDIENCE, algorithms: ['RS256'] });
      providerId = payload.provider_id;
    } catch (error) {
      // IdP fora do ar não é culpa do token: o provedor pode reenviar
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
        throw new ServiceUnavailableException('IdP indisponível');
      }
      throw new UnauthorizedException('Token inválido');
    }
    if (typeof providerId !== 'string' || providerId === '') throw new UnauthorizedException('Token sem claim provider_id');

    const claimed = [req.params.providerId, (req.body as { providerId?: unknown } | undefined)?.providerId];
    if (claimed.some((p) => p !== undefined && p !== providerId)) {
      throw new ForbiddenException(`Token do provedor ${providerId} não age em nome de outro provedor`);
    }
    providers.set(req, providerId);
    return true;
  }
}
