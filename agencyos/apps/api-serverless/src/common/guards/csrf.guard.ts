import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isExplicitDevelopmentEnv, safeEqual } from '../utils/security';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private config: ConfigService) {}
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const origin = req.headers.origin as string | undefined;
    // Public auth endpoints can set cookies even before a refresh cookie exists. Reject
    // foreign browser origins there too (login CSRF), while allowing origin-less API clients.
    const authRoute = /^\/api\/v1\/auth\//.test(req.originalUrl?.split('?')[0] ?? req.url ?? '');
    if ((authRoute || req.authMethod === 'cookie' || req.cookies?.agencyos_refresh) && origin && !isAllowedOrigin(origin, this.config.getOrThrow<string>('WEB_URL'), !isExplicitDevelopmentEnv())) throw new ForbiddenException('Cross-origin request rejected');
    if (req.authMethod !== 'cookie' && !req.cookies?.agencyos_refresh) return true;
    const cookie = req.cookies?.agencyos_csrf;
    const header = req.headers['x-csrf-token'];
    if (typeof cookie !== 'string' || typeof header !== 'string' || !cookie || !header || !safeEqual(cookie, header)) {
      throw new ForbiddenException('CSRF token missing or invalid');
    }
    return true;
  }
}

/** Exact WEB_URL match in production; localhost aliases and E2B preview hosts in development/test. */
export function isAllowedOrigin(origin: string, webUrl: string, production: boolean): boolean {
  try {
    const o = new URL(origin); const w = new URL(webUrl);
    if (o.origin === w.origin) return true;
    if (production) return false;
    const local = ['localhost', '127.0.0.1', '[::1]'];
    if (local.includes(o.hostname) && local.includes(w.hostname)) return true;
    if (o.hostname.endsWith('.e2b.app')) return true;
    return false;
  } catch { return false; }
}
