import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService, private config: ConfigService, private prisma: PrismaService) {}
  async canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const token = bearer || req.cookies?.agencyos_access;
    if (!token) throw new UnauthorizedException('Authentication required');
    try {
      const payload = await this.jwt.verifyAsync(token, { secret: this.config.getOrThrow('JWT_ACCESS_SECRET') });
      if (payload.type !== 'access' || typeof payload.family !== 'string') throw new Error('wrong token type');
      // One query: the user plus proof that the token's session family still has a live refresh
      // session. Rotation keeps the family alive; logout, password change/reset, deactivation and
      // refresh-token reuse revoke it, which now ends the access token immediately as well.
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, email: true, name: true, platformRole: true, isActive: true, refreshSessions: { where: { familyId: payload.family, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true }, take: 1 } } });
      if (!user || !user.isActive || !user.refreshSessions.length) throw new Error('inactive or revoked');
      req.user = { id: user.id, email: user.email, name: user.name, platformRole: user.platformRole };
      req.authMethod = bearer ? 'bearer' : 'cookie';
      return true;
    } catch { throw new UnauthorizedException('Invalid or expired session'); }
  }
}
