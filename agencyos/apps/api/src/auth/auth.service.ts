import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { isExplicitDevelopmentEnv, randomToken, sha256, slugify } from '../common/utils/security';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AcceptInvitationDto, LoginDto, RegisterDto } from './dto';
import { IntegrationsService } from '../integrations/integrations.service';
import { AuditService } from '../common/audit.service';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private config: ConfigService, private integrations: IntegrationsService, private audit: AuditService) {}

  private accessTtl() { return this.config.get<number>('ACCESS_TOKEN_TTL_SECONDS') ?? 900; }
  private refreshTtl() { return this.config.get<number>('REFRESH_TOKEN_TTL_SECONDS') ?? 604800; }

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Email already registered');
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const base = slugify(dto.organizationName);
    let slug = base; let n = 1;
    while (await this.prisma.organization.findUnique({ where: { slug } })) slug = `${base}-${++n}`;
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email, name: dto.name, passwordHash } });
      const org = await tx.organization.create({ data: { name: dto.organizationName, slug, memberships: { create: { userId: u.id, role: 'OWNER' } }, subscription: { create: { plan: 'starter', status: 'TRIALING', seatLimit: 10 } } } });
      await tx.auditEvent.create({ data: { organizationId: org.id, actorId: u.id, action: 'organization.created', entityType: 'Organization', entityId: org.id } });
      return u;
    });
    return this.issueSession(user.id);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    // Constant-ish work factor for unknown accounts to reduce user enumeration timing signal.
    const hash = user?.passwordHash ?? '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpDLh8Y9Q9Q9Q9Q9Q9Q9Q9Q9Q9Q9u';
    const ok = await bcrypt.compare(dto.password, hash);
    if (!user || !ok || !user.isActive) throw new UnauthorizedException('Invalid email or password');
    return this.issueSession(user.id);
  }

  async issueSession(userId: string, familyId: string = randomUUID(), db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, name: true, platformRole: true, isActive: true } });
    if (!user.isActive) throw new UnauthorizedException('Account is disabled');
    const sessionId = randomUUID();
    const refresh = await this.jwt.signAsync({ sub: userId, sid: sessionId, family: familyId, type: 'refresh' }, { secret: this.config.getOrThrow('JWT_REFRESH_SECRET'), expiresIn: this.refreshTtl() });
    await db.refreshSession.create({ data: { id: sessionId, userId, familyId, tokenHash: sha256(refresh), expiresAt: new Date(Date.now() + this.refreshTtl() * 1000) } });
    // The access token carries its session family so it dies with the session (logout, password
    // change/reset, deactivation, refresh-token reuse) instead of living until it expires.
    const access = await this.jwt.signAsync({ sub: userId, family: familyId, type: 'access' }, { secret: this.config.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: this.accessTtl() });
    const { isActive: _isActive, ...safeUser } = user;
    return { user: safeUser, accessToken: access, refreshToken: refresh, csrfToken: randomToken(24), expiresIn: this.accessTtl() };
  }

  async refresh(refreshToken?: string) {
    if (!refreshToken) throw new UnauthorizedException('Refresh session required');
    let payload: any;
    try { payload = await this.jwt.verifyAsync(refreshToken, { secret: this.config.getOrThrow('JWT_REFRESH_SECRET') }); } catch { throw new UnauthorizedException('Invalid refresh session'); }
    if (payload.type !== 'refresh') throw new UnauthorizedException('Invalid token type');
    const session = await this.prisma.refreshSession.findUnique({ where: { id: payload.sid } });
    if (!session || session.tokenHash !== sha256(refreshToken) || session.userId !== payload.sub || session.familyId !== payload.family || session.expiresAt < new Date()) throw new UnauthorizedException('Refresh session expired');
    // Atomically claim the old session and create its successor in one transaction. A
    // concurrent reuse waits for the claim, then revokes the entire committed family.
    const next = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshSession.updateMany({ where: { id: session.id, revokedAt: null, expiresAt: { gt: new Date() } }, data: { revokedAt: new Date() } });
      if (claimed.count !== 1) {
        await tx.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        return null;
      }
      return this.issueSession(session.userId, session.familyId, tx);
    });
    if (!next) throw new UnauthorizedException('Refresh token reuse detected');
    return next;
  }

  async logout(refreshToken?: string) {
    if (!refreshToken) return;
    try {
      const payload = await this.jwt.verifyAsync(refreshToken, { secret: this.config.getOrThrow('JWT_REFRESH_SECRET') });
      await this.prisma.refreshSession.updateMany({ where: { id: payload.sid, revokedAt: null }, data: { revokedAt: new Date() } });
    } catch { /* idempotent logout */ }
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, name: true, platformRole: true, createdAt: true, memberships: { include: { organization: { select: { id: true, name: true, slug: true } }, client: { select: { id: true, name: true } } } } } });
    return user;
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    const generic = { message: 'If the account exists, a recovery email has been sent.' };
    if (!user) return generic;
    const token = randomToken();
    await this.prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
    const url = `${this.config.getOrThrow('WEB_URL')}/reset-password?token=${token}`;
    const sent = await this.integrations.sendEmail(user.email, 'Reset your AgencyOS password', `<p>Reset your password within one hour:</p><p><a href="${url}">${url}</a></p>`);
    await this.audit.record({ actorId: user.id, action: 'auth.password_reset_requested', entityType: 'User', entityId: user.id });
    // Never disclose account existence or delivery outcome in production.
    if (this.config.get('NODE_ENV') === 'production' || !isExplicitDevelopmentEnv()) return generic;
    // Development convenience only; never returned in production.
    if (!sent) return { ...generic, developmentResetUrl: url, emailDelivered: false };
    return generic;
  }

  async resetPassword(token: string, password: string) {
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) throw new BadRequestException('Invalid or expired recovery token');
    const passwordHash = await bcrypt.hash(password, 12);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) throw new BadRequestException('Invalid or expired recovery token');
      await tx.passwordResetToken.updateMany({ where: { userId: record.userId, usedAt: null }, data: { usedAt: new Date() } });
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      await tx.refreshSession.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    return { message: 'Password updated. Sign in again.' };
  }

  async acceptInvitation(dto: AcceptInvitationDto) {
    const inv = await this.prisma.invitation.findUnique({ where: { tokenHash: sha256(dto.token) }, include: { organization: true } });
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw new BadRequestException('Invalid or expired invitation');
    let user = await this.prisma.user.findUnique({ where: { email: inv.email } });
    if (!user) {
      if (!dto.password || !dto.name) throw new BadRequestException('Name and password are required for new accounts');
      user = await this.prisma.user.create({ data: { email: inv.email, name: dto.name, passwordHash: await bcrypt.hash(dto.password, 12) } });
    } else {
      // Existing accounts must prove ownership of the invited email; an invitation link alone must never mint a session.
      if (!dto.password || !(await bcrypt.compare(dto.password, user.passwordHash))) throw new BadRequestException('Password is required to accept an invitation for an existing account');
      if (!user.isActive) throw new BadRequestException('Account is disabled');
    }
    const existing = await this.prisma.membership.findUnique({ where: { organizationId_userId: { organizationId: inv.organizationId, userId: user.id } } });
    if (existing) throw new ConflictException('User is already a member');
    await this.prisma.$transaction(async (tx) => {
      await tx.membership.create({ data: { organizationId: inv.organizationId, userId: user!.id, role: inv.role, clientId: inv.clientId } });
      await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
      await tx.auditEvent.create({ data: { organizationId: inv.organizationId, actorId: user!.id, action: 'membership.invitation_accepted', entityType: 'Membership', entityId: user!.id } });
    });
    return this.issueSession(user.id);
  }
}
