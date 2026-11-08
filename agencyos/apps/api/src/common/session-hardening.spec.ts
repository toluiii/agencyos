/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma/Stripe test doubles */
import 'reflect-metadata';
import { BadRequestException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { isExplicitDevelopmentEnv } from './utils/security';
import { BillingService } from '../billing/billing.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { OrganizationsController } from '../organizations/organizations.controller';
import { IntegrationsService } from '../integrations/integrations.service';

const httpContext = (headers: Record<string, string>) => {
  const req: any = { headers, cookies: {} };
  return { req, ctx: { getHandler: () => undefined, getClass: () => undefined, switchToHttp: () => ({ getRequest: () => req }) } as any };
};

describe('access tokens are tied to a live session family', () => {
  const reflector = { getAllAndOverride: () => false } as any;
  const config = { getOrThrow: () => 'secret' } as any;
  const activeUser = { id: 'u1', email: 'a@b.co', name: 'A', platformRole: 'USER', isActive: true };
  const guardWith = (payload: object, user: unknown) => {
    const findUnique = jest.fn().mockResolvedValue(user);
    const guard = new JwtAuthGuard(reflector, { verifyAsync: jest.fn().mockResolvedValue(payload) } as any, config, { user: { findUnique } } as any);
    return { guard, findUnique };
  };

  it('accepts a token whose family still has an unrevoked, unexpired refresh session', async () => {
    const { guard, findUnique } = guardWith({ sub: 'u1', type: 'access', family: 'fam-1' }, { ...activeUser, refreshSessions: [{ id: 's1' }] });
    const { req, ctx } = httpContext({ authorization: 'Bearer tkn' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ id: 'u1', email: 'a@b.co', name: 'A', platformRole: 'USER' });
    const where = findUnique.mock.calls[0][0].select.refreshSessions.where;
    expect(where).toMatchObject({ familyId: 'fam-1', revokedAt: null });
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });
  it('rejects a token after its family was revoked (logout, password reset, reuse detection)', async () => {
    const { guard } = guardWith({ sub: 'u1', type: 'access', family: 'fam-1' }, { ...activeUser, refreshSessions: [] });
    await expect(guard.canActivate(httpContext({ authorization: 'Bearer tkn' }).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('rejects legacy tokens without a family and deactivated users', async () => {
    const legacy = guardWith({ sub: 'u1', type: 'access' }, { ...activeUser, refreshSessions: [{ id: 's1' }] });
    await expect(legacy.guard.canActivate(httpContext({ authorization: 'Bearer tkn' }).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(legacy.findUnique).not.toHaveBeenCalled();
    const inactive = guardWith({ sub: 'u1', type: 'access', family: 'f' }, { ...activeUser, isActive: false, refreshSessions: [{ id: 's1' }] });
    await expect(inactive.guard.canActivate(httpContext({ authorization: 'Bearer tkn' }).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('development-only behaviour fails closed', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = original; });
  it('is enabled only for an explicit development or test NODE_ENV', () => {
    for (const [value, expected] of [['development', true], ['test', true], ['production', false], ['staging', false], [undefined, false]] as const) {
      if (value === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = value;
      expect(isExplicitDevelopmentEnv()).toBe(expected);
    }
  });
});

describe('editing or voiding an invoice releases its Stripe checkout session', () => {
  const setup = (retrieve: jest.Mock, expire = jest.fn().mockResolvedValue({})) => {
    const update = jest.fn().mockResolvedValue({});
    const integrations = { getStripe: () => ({ checkout: { sessions: { retrieve, expire } } }) };
    const service = new BillingService({ invoice: { update } } as any, { get: () => 'sk_test' } as any, integrations as any, {} as any, {} as any);
    const release = (inv: { id: string; stripeSessionId: string | null }) => (service as any).releaseCheckout(inv);
    return { release, update, expire };
  };
  it('expires an open session so the old amount can no longer be paid', async () => {
    const { release, update, expire } = setup(jest.fn().mockResolvedValue({ id: 'cs_1', status: 'open' }));
    await release({ id: 'inv-1', stripeSessionId: 'cs_1' });
    expect(expire).toHaveBeenCalledWith('cs_1');
    expect(update).toHaveBeenCalledWith({ where: { id: 'inv-1' }, data: { stripeSessionId: null } });
  });
  it('refuses when the client has just completed the payment', async () => {
    const { release, update, expire } = setup(jest.fn().mockResolvedValue({ id: 'cs_1', status: 'complete' }));
    await expect(release({ id: 'inv-1', stripeSessionId: 'cs_1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(expire).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it('treats a session Stripe no longer knows as released, and a Stripe outage as 503', async () => {
    const missing = setup(jest.fn().mockRejectedValue(Object.assign(new Error('No such session'), { code: 'resource_missing' })));
    await missing.release({ id: 'inv-1', stripeSessionId: 'cs_gone' });
    expect(missing.update).toHaveBeenCalled();
    const down = setup(jest.fn().mockRejectedValue(new Error('ECONNRESET')));
    await expect(down.release({ id: 'inv-1', stripeSessionId: 'cs_1' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(down.update).not.toHaveBeenCalled();
  });
  it('does nothing for invoices without a session', async () => {
    const retrieve = jest.fn();
    const { release, update } = setup(retrieve);
    await release({ id: 'inv-1', stripeSessionId: null });
    expect(retrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('retention purge', () => {
  it('deletes only expired or long-settled rows, using the documented cut-offs', async () => {
    const del = () => jest.fn((args) => ({ args, count: 1 }));
    const prisma: any = { refreshSession: { deleteMany: del() }, passwordResetToken: { deleteMany: del() }, invitation: { deleteMany: del() }, notification: { deleteMany: del() }, webhookEvent: { deleteMany: del() } };
    prisma.$transaction = jest.fn(async (ops: unknown[]) => ops);
    const now = new Date('2026-11-08T03:00:00Z');
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000);
    const result = await new MaintenanceService(prisma).purgeExpiredRecords(now);
    expect(result).toEqual({ refreshSessions: 1, resetTokens: 1, invitations: 1, notifications: 1, webhookEvents: 1 });
    expect(prisma.refreshSession.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: daysAgo(1) } } });
    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: daysAgo(1) } } });
    expect(prisma.invitation.deleteMany).toHaveBeenCalledWith({ where: { acceptedAt: null, expiresAt: { lt: daysAgo(30) } } });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { readAt: { lt: daysAgo(90) } } });
    expect(prisma.webhookEvent.deleteMany).toHaveBeenCalledWith({ where: { processedAt: { lt: daysAgo(90) } } });
  });
});

describe('client portal users do not see agency plan details', () => {
  it('strips subscription and counts from client memberships in the organization list', async () => {
    const org = (id: string) => ({ id, name: id, slug: id, subscription: { plan: 'pro', seats: 10 }, _count: { clients: 3, projects: 4, memberships: 5 } });
    const findMany = jest.fn().mockResolvedValue([{ role: 'OWNER', clientId: null, organization: org('own') }, { role: 'CLIENT', clientId: 'c1', organization: org('agency') }]);
    const controller = new OrganizationsController({ membership: { findMany } } as any, {} as any);
    const { data } = await controller.list({ id: 'u1' } as any);
    expect(data[0]).toMatchObject({ id: 'own', role: 'OWNER', subscription: { plan: 'pro' } });
    expect(data[1]).toEqual({ id: 'agency', name: 'agency', slug: 'agency', role: 'CLIENT', clientId: 'c1' });
  });
  it('returns only basic organization fields to clients on the detail endpoint', async () => {
    const findUniqueOrThrow = jest.fn().mockResolvedValue({});
    const controller = new OrganizationsController({ organization: { findUniqueOrThrow } } as any, {} as any);
    await controller.get('org-a', { organizationId: 'org-a', userId: 'u2', role: 'CLIENT', clientId: 'c1' });
    expect(findUniqueOrThrow.mock.calls[0][0]).toEqual({ where: { id: 'org-a' }, select: { id: true, name: true, slug: true, description: true } });
  });
});

describe('document downloads are streamed', () => {
  it('reports a missing local file as 404 and still rejects traversal', async () => {
    const service = new IntegrationsService({ get: () => undefined } as any);
    await expect(service.openFileStream(`missing/${randomUUID()}`)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.openFileStream('../storage-other/secret')).rejects.toThrow('Invalid storage key');
  });
  it('streams the stored bytes and reports their size for Content-Length', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agencyos-storage-'));
    const previous = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = dir;
    try {
      const service = new IntegrationsService({ get: () => undefined } as any);
      await service.putFile('org-a/doc.txt', Buffer.from('hello portal'), 'text/plain');
      const { stream, size } = await service.openFileStream('org-a/doc.txt');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe('hello portal');
      expect(size).toBe(12);
    } finally {
      if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
