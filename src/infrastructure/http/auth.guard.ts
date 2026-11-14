import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação (ARCHITECTURE.md, Autenticação): hoje deixa tudo passar.
 * shortcut: no-op, trocar por validação do JWT do IdP (JWKS) + providerId do token == providerId do payload.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
