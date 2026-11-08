import { INestApplication } from '@nestjs/common';
import Stripe from 'stripe';
import { createTestApp, resetDb, api, auth, register } from './helpers';
import { PrismaService } from '../src/prisma/prisma.service';

describe('AgencyOS API integration workflows', () => {
  let app: INestApplication; let prisma: PrismaService;
  const suffix = `${Date.now()}`;
  let owner: Awaited<ReturnType<typeof register>>; let other: Awaited<ReturnType<typeof register>>;
  let devToken = ''; let devUserId = ''; let clientToken = ''; let clientId = ''; let projectId = ''; let taskId = ''; let invoiceId = ''; let draftInvoiceId = '';
  beforeAll(async () => { app = await createTestApp(); prisma = app.get(PrismaService); await resetDb(app); owner = await register(app, `${suffix}-a`, 'Alpha Agency'); other = await register(app, `${suffix}-b`, 'Beta Agency'); });
  afterAll(async () => { await app?.close(); });

  it('1. registers an agency and creates an owner membership + trial subscription', async () => {
    const me = await api(app).get('/api/v1/auth/me').set(auth(owner.token)).expect(200);
    expect(me.body.memberships[0].role).toBe('OWNER');
    const org = await api(app).get(`/api/v1/organizations/${owner.orgId}`).set(auth(owner.token, owner.orgId)).expect(200);
    expect(org.body.subscription.status).toBe('TRIALING');
    await api(app).get(`/api/v1/organizations/${other.orgId}`).set(auth(owner.token, owner.orgId)).expect(403);
  });

  it('2. creates an additional organization for the same user', async () => {
    const res = await api(app).post('/api/v1/organizations').set(auth(owner.token)).send({ name: 'Second Workspace' }).expect(201);
    const orgs = await api(app).get('/api/v1/organizations').set(auth(owner.token)).expect(200);
    expect(orgs.body.data.map((o: any) => o.id)).toContain(res.body.id);
  });

  it('3. invites a developer and accepts the invitation with a new account', async () => {
    const inv = await api(app).post('/api/v1/memberships/invite').set(auth(owner.token, owner.orgId)).send({ email: `dev-${suffix}@test.dev`, role: 'DEVELOPER' }).expect(201);
    expect(inv.body.emailDelivered).toBe(false);
    const token = new URL(inv.body.invitationUrl).searchParams.get('token')!;
    const accepted = await api(app).post('/api/v1/auth/accept-invitation').send({ token, name: 'Dev User', password: 'Password123!' }).expect(201);
    devToken = accepted.body.accessToken; devUserId = accepted.body.user.id;
    const members = await api(app).get('/api/v1/memberships').set(auth(owner.token, owner.orgId)).expect(200);
    expect(members.body.some((m: any) => m.user.email === `dev-${suffix}@test.dev` && m.role === 'DEVELOPER')).toBe(true);
  });

  it('4. creates a client with contacts and onboarding checklist', async () => {
    const res = await api(app).post('/api/v1/clients').set(auth(owner.token, owner.orgId)).send({ name: 'Acme Test', company: 'Acme Inc', accountManagerId: owner.userId, contacts: [{ name: 'Jane Contact', email: `jane-${suffix}@acme.test`, isPrimary: true }] }).expect(201);
    clientId = res.body.id; expect(res.body.contacts).toHaveLength(1); expect(res.body.onboardingSteps.length).toBeGreaterThan(0);
    const steps = res.body.onboardingSteps.map((s: any) => ({ ...s, done: true }));
    const updated = await api(app).patch(`/api/v1/clients/${clientId}/onboarding`).set(auth(owner.token, owner.orgId)).send({ steps }).expect(200);
    expect(updated.body.status).toBe('ACTIVE');
  });

  it('5. creates a project and assigns the developer', async () => {
    const res = await api(app).post('/api/v1/projects').set(auth(owner.token, owner.orgId)).send({ name: 'Portal Build', clientId, budget: 10000, memberIds: [devUserId], dueDate: new Date(Date.now() + 20 * 86400000).toISOString() }).expect(201);
    projectId = res.body.id; expect(res.body.members).toHaveLength(2);
  });

  it('6. creates, assigns, moves and guards task dependencies', async () => {
    const t1 = await api(app).post('/api/v1/tasks').set(auth(owner.token, owner.orgId)).send({ projectId, title: 'Auth module', assigneeId: devUserId, priority: 'HIGH' }).expect(201);
    taskId = t1.body.id;
    const t2 = await api(app).post('/api/v1/tasks').set(auth(owner.token, owner.orgId)).send({ projectId, title: 'Billing module', assigneeId: devUserId }).expect(201);
    await api(app).post(`/api/v1/tasks/${t2.body.id}/dependencies`).set(auth(owner.token, owner.orgId)).send({ prerequisiteId: taskId }).expect(201);
    await api(app).post(`/api/v1/tasks/${taskId}/dependencies`).set(auth(owner.token, owner.orgId)).send({ prerequisiteId: t2.body.id }).expect(400); // cycle
    await api(app).patch(`/api/v1/tasks/${t2.body.id}/move`).set(auth(owner.token, owner.orgId)).send({ status: 'DONE', position: 0 }).expect(400); // blocked
    await api(app).patch(`/api/v1/tasks/${taskId}/move`).set(auth(devToken, owner.orgId)).send({ status: 'IN_PROGRESS', position: 0 }).expect(200);
    await api(app).patch(`/api/v1/tasks/${taskId}/move`).set(auth(devToken, owner.orgId)).send({ status: 'DONE', position: 0 }).expect(200);
    await api(app).patch(`/api/v1/tasks/${t2.body.id}/move`).set(auth(devToken, owner.orgId)).send({ status: 'DONE', position: 1 }).expect(200);
    const project = await api(app).get(`/api/v1/projects/${projectId}`).set(auth(owner.token, owner.orgId)).expect(200);
    expect(project.body.status).toBe('COMPLETED');
  });

  it('7. grants scoped client portal access and hides other organizations', async () => {
    const inv = await api(app).post('/api/v1/memberships/invite').set(auth(owner.token, owner.orgId)).send({ email: `client-${suffix}@acme.test`, role: 'CLIENT', clientId }).expect(201);
    const token = new URL(inv.body.invitationUrl).searchParams.get('token')!;
    const accepted = await api(app).post('/api/v1/auth/accept-invitation').send({ token, name: 'Client User', password: 'Password123!' }).expect(201);
    clientToken = accepted.body.accessToken;
    const projects = await api(app).get('/api/v1/projects').set(auth(clientToken, owner.orgId)).expect(200);
    expect(projects.body.data).toHaveLength(1); expect(projects.body.data[0].id).toBe(projectId);
    await api(app).post('/api/v1/projects').set(auth(clientToken, owner.orgId)).send({ name: 'Hack', clientId }).expect(403);
    await api(app).get('/api/v1/memberships').set(auth(clientToken, owner.orgId)).expect(403);
    await api(app).get(`/api/v1/clients/${clientId}`).set(auth(other.token, owner.orgId)).expect(403); // not a member
    await api(app).get(`/api/v1/clients/${clientId}`).set(auth(other.token, other.orgId)).expect(404); // wrong tenant
    await api(app).post('/api/v1/projects').set(auth(other.token, other.orgId)).send({ name: 'Cross', clientId }).expect(400); // cross-tenant reference
  });

  it('8. creates invoices with server-calculated totals and enforces finance roles', async () => {
    await api(app).post('/api/v1/billing/invoices').set(auth(devToken, owner.orgId)).send({ clientId, dueDate: new Date().toISOString(), items: [{ description: 'x', quantity: 1, unitPrice: 1 }] }).expect(403);
    const inv = await api(app).post('/api/v1/billing/invoices').set(auth(owner.token, owner.orgId)).send({ clientId, projectId, dueDate: new Date(Date.now() + 14 * 86400000).toISOString(), taxRate: 10, items: [{ description: 'Milestone', quantity: 2, unitPrice: 1500.25 }] }).expect(201);
    invoiceId = inv.body.id; expect(Number(inv.body.subtotal)).toBe(3000.5); expect(Number(inv.body.taxAmount)).toBe(300.05); expect(Number(inv.body.total)).toBe(3300.55); expect(inv.body.status).toBe('DRAFT');
    const draft = await api(app).post('/api/v1/billing/invoices').set(auth(owner.token, owner.orgId)).send({ clientId, dueDate: new Date().toISOString(), items: [{ description: 'Draft', quantity: 1, unitPrice: 10 }] }).expect(201);
    draftInvoiceId = draft.body.id;
    await api(app).post(`/api/v1/billing/invoices/${invoiceId}/send`).set(auth(owner.token, owner.orgId)).expect(201);
    const clientInvoices = await api(app).get('/api/v1/billing/invoices').set(auth(clientToken, owner.orgId)).expect(200);
    expect(clientInvoices.body.data.map((i: any) => i.id)).toEqual([invoiceId]); // draft hidden
    const draftSearch = await api(app).get('/api/v1/billing/invoices?status=DRAFT').set(auth(clientToken, owner.orgId)).expect(200);
    expect(draftSearch.body.data).toEqual([]);
    const otherClient = await api(app).post('/api/v1/clients').set(auth(owner.token, owner.orgId)).send({ name: 'Other client' }).expect(201);
    const otherInvoice = await api(app).post('/api/v1/billing/invoices').set(auth(owner.token, owner.orgId)).send({ clientId: otherClient.body.id, dueDate: new Date().toISOString(), items: [{ description: 'Other client', quantity: 1, unitPrice: 10 }] }).expect(201);
    await api(app).post(`/api/v1/billing/invoices/${otherInvoice.body.id}/send`).set(auth(owner.token, owner.orgId)).expect(201);
    const crossClientSearch = await api(app).get(`/api/v1/billing/invoices?clientId=${otherClient.body.id}`).set(auth(clientToken, owner.orgId)).expect(200);
    expect(crossClientSearch.body.data).toEqual([]);
    const ownClient = await api(app).get(`/api/v1/clients/${clientId}`).set(auth(clientToken, owner.orgId)).expect(200);
    expect(ownClient.body).not.toHaveProperty('notes');
    expect(ownClient.body.invoices.some((i: any) => i.id === draftInvoiceId)).toBe(false);
    await api(app).get(`/api/v1/clients/${otherClient.body.id}`).set(auth(clientToken, owner.orgId)).expect(404);
    await api(app).get(`/api/v1/billing/invoices/${draftInvoiceId}`).set(auth(clientToken, owner.orgId)).expect(404);
  });

  it('9. verifies Stripe webhook signatures, amounts and idempotent payment processing', async () => {
    const stripe = new Stripe('sk_test_integration_dummy');
    const secret = process.env.STRIPE_WEBHOOK_SECRET!;
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const event = { id: `evt_${suffix}_1`, object: 'event', api_version: '2025-01-01', created: Math.floor(Date.now() / 1000), livemode: false, type: 'checkout.session.completed', pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object: { id: `cs_${suffix}`, object: 'checkout.session', payment_status: 'paid', amount_total: Math.round(Number(invoice.total) * 100), currency: 'usd', payment_intent: `pi_${suffix}`, client_reference_id: invoice.id, metadata: { invoiceId: invoice.id, organizationId: owner.orgId } } } };
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    const first = await api(app).post('/api/v1/billing/webhooks/stripe').set('stripe-signature', header).set('Content-Type', 'application/json').send(payload).expect(201);
    expect(first.body.paid).toBe(true);
    const second = await api(app).post('/api/v1/billing/webhooks/stripe').set('stripe-signature', header).set('Content-Type', 'application/json').send(payload).expect(201);
    expect(second.body.duplicate).toBe(true);
    const payments = await prisma.payment.count({ where: { invoiceId } }); expect(payments).toBe(1);
    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }); expect(paid.status).toBe('PAID');
    await api(app).post('/api/v1/billing/webhooks/stripe').set('stripe-signature', 't=1,v1=bad').set('Content-Type', 'application/json').send(payload).expect(400);
    const mismatch = { ...event, id: `evt_${suffix}_2`, data: { object: { ...event.data.object, amount_total: 1 } } };
    const mismatchPayload = JSON.stringify(mismatch);
    await api(app).post('/api/v1/billing/webhooks/stripe').set('stripe-signature', stripe.webhooks.generateTestHeaderString({ payload: mismatchPayload, secret })).set('Content-Type', 'application/json').send(mismatchPayload).expect(400);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe('PAID');
  });

  it('10. delivers in-app notifications for invoice and payment events', async () => {
    const clientNotifications = await api(app).get('/api/v1/notifications').set(auth(clientToken, owner.orgId)).expect(200);
    expect(clientNotifications.body.some((n: any) => n.type === 'PAYMENT' && n.title.includes('is ready'))).toBe(true);
    const ownerNotifications = await api(app).get('/api/v1/notifications').set(auth(owner.token, owner.orgId)).expect(200);
    expect(ownerNotifications.body.some((n: any) => n.title.startsWith('Payment received'))).toBe(true);
    const id = clientNotifications.body[0].id;
    await api(app).patch(`/api/v1/notifications/${id}/read`).set(auth(clientToken, owner.orgId)).send({}).expect(200);
    const after = await api(app).get('/api/v1/notifications?unread=true').set(auth(clientToken, owner.orgId)).expect(200);
    expect(after.body.some((n: any) => n.id === id)).toBe(false);
  });

  it('enforces authentication, CSRF for cookie sessions, refresh rotation and recovery', async () => {
    await api(app).get('/api/v1/auth/me').expect(401);
    await api(app).post('/api/v1/auth/login').send({ email: `user-${suffix}-a@test.dev`, password: 'wrong' }).expect(401);
    const agent = await import('supertest').then((m) => m.default.agent(app.getHttpServer()));
    const login = await agent.post('/api/v1/auth/login').send({ email: `user-${suffix}-a@test.dev`, password: 'Password123!' }).expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const csrf = cookies.find((c) => c.startsWith('agencyos_csrf='))!.split(';')[0].split('=')[1];
    await agent.post('/api/v1/clients').set('x-organization-id', owner.orgId).send({ name: 'No CSRF' }).expect(403);
    await agent.post('/api/v1/clients').set('x-organization-id', owner.orgId).set('x-csrf-token', csrf).send({ name: 'With CSRF' }).expect(201);
    const refreshCookie = cookies.find((c) => c.startsWith('agencyos_refresh='))!.split(';')[0];
    const r1 = await agent.post('/api/v1/auth/refresh').set('x-csrf-token', csrf).send({}).expect(200);
    expect(r1.body.accessToken).toBeTruthy();
    const r1Cookies = r1.headers['set-cookie'] as unknown as string[];
    const newCsrf = r1Cookies.find((c) => c.startsWith('agencyos_csrf='))!.split(';')[0].split('=')[1];
    // Reusing the original rotated refresh cookie (with the current CSRF token) revokes the family.
    await api(app).post('/api/v1/auth/refresh').set('Cookie', `${refreshCookie}; agencyos_csrf=${newCsrf}`).set('x-csrf-token', newCsrf).send({}).expect(401);
    const forgot = await api(app).post('/api/v1/auth/forgot-password').send({ email: `user-${suffix}-a@test.dev` }).expect(200);
    expect(forgot.body.emailDelivered).toBe(false); expect(forgot.body.developmentResetUrl).toContain('/reset-password?token=');
    const resetToken = new URL(forgot.body.developmentResetUrl).searchParams.get('token')!;
    await api(app).post('/api/v1/auth/reset-password').send({ token: resetToken, password: 'NewPassword123!' }).expect(200);
    await api(app).post('/api/v1/auth/reset-password').send({ token: resetToken, password: 'Another123!' }).expect(400);
    // A password reset revokes every session, including access tokens issued before it.
    await api(app).get('/api/v1/auth/me').set(auth(owner.token)).expect(401);
    const relogin = await api(app).post('/api/v1/auth/login').send({ email: `user-${suffix}-a@test.dev`, password: 'NewPassword123!' }).expect(200);
    owner.token = relogin.body.accessToken;
    await api(app).get('/api/v1/auth/me').set(auth(owner.token)).expect(200);
  });

  it('reports integration availability honestly and never fabricates AI output', async () => {
    const status = await api(app).get('/api/v1/integrations/status').set(auth(owner.token, owner.orgId)).expect(200);
    expect(status.body.openai.configured).toBe(false); expect(status.body.email.configured).toBe(false); expect(status.body.storage.provider).toBe('local');
    const ai = await api(app).post('/api/v1/ai/assist').set(auth(owner.token, owner.orgId)).send({ action: 'project_summary' }).expect(503);
    expect(ai.body.code).toBe('AI_UNAVAILABLE'); expect(ai.body.result).toBeUndefined();
    // The assistant is an agency tool: client sessions must not reach it at all.
    await api(app).post('/api/v1/ai/assist').set(auth(clientToken, owner.orgId)).send({ action: 'project_summary' }).expect(403);
    await api(app).get('/api/v1/ai/status').set(auth(clientToken, owner.orgId)).expect(403);
  });

  it('supports documents upload/download with tenant scoping and validates pagination/filtering', async () => {
    const up = await api(app).post('/api/v1/documents/upload').set(auth(clientToken, owner.orgId)).field('clientId', clientId).attach('file', Buffer.from('hello portal'), { filename: 'note.txt', contentType: 'text/plain' }).expect(201);
    expect(up.body.provider).toBe('LOCAL');
    const dl = await api(app).get(`/api/v1/documents/${up.body.id}/download`).set(auth(clientToken, owner.orgId)).expect(200);
    expect(dl.text).toBe('hello portal');
    await api(app).get(`/api/v1/documents/${up.body.id}/download`).set(auth(other.token, other.orgId)).expect(404);
    const page = await api(app).get('/api/v1/clients?page=1&limit=1&q=Acme').set(auth(owner.token, owner.orgId)).expect(200);
    expect(page.body.meta.limit).toBe(1); expect(page.body.data[0].name).toBe('Acme Test');
    await api(app).get('/api/v1/clients?limit=1000').set(auth(owner.token, owner.orgId)).expect(400);
    const agencyDoc = await api(app).post('/api/v1/documents/upload').set(auth(owner.token, owner.orgId)).field('clientId', clientId).attach('file', Buffer.from('agency contract'), { filename: 'contract.txt', contentType: 'text/plain' }).expect(201);
    await api(app).delete(`/api/v1/documents/${agencyDoc.body.id}`).set(auth(clientToken, owner.orgId)).expect(403);
    await api(app).delete(`/api/v1/documents/${up.body.id}`).set(auth(clientToken, owner.orgId)).expect(200);
  });

  it('rejects comments that do not target exactly one parent', async () => {
    await api(app).post('/api/v1/comments').set(auth(owner.token, owner.orgId)).send({ body: 'No parent' }).expect(400);
    const ticket = await api(app).post('/api/v1/support/tickets').set(auth(clientToken, owner.orgId)).send({ subject: 'Comment target check', description: 'Verifying the exactly-one-parent rule.' }).expect(201);
    await api(app).post('/api/v1/comments').set(auth(owner.token, owner.orgId)).send({ body: 'Two parents', ticketId: ticket.body.id, taskId }).expect(400);
  });

  it('support tickets notify managers and remain scoped to the client', async () => {
    const ticket = await api(app).post('/api/v1/support/tickets').set(auth(clientToken, owner.orgId)).send({ subject: 'Export broken', description: 'The CSV export fails for large reports.' }).expect(201);
    expect(ticket.body.clientId).toBe(clientId);
    const ownerNotifications = await api(app).get('/api/v1/notifications').set(auth(owner.token, owner.orgId)).expect(200);
    expect(ownerNotifications.body.some((n: any) => n.type === 'SUPPORT')).toBe(true);
    await api(app).post('/api/v1/comments').set(auth(devToken, owner.orgId)).send({ ticketId: ticket.body.id, body: 'Looking into it.' }).expect(201);
    await api(app).patch(`/api/v1/support/tickets/${ticket.body.id}`).set(auth(clientToken, owner.orgId)).send({ status: 'CLOSED' }).expect(403);
    await api(app).patch(`/api/v1/support/tickets/${ticket.body.id}`).set(auth(devToken, owner.orgId)).send({ status: 'IN_PROGRESS', assigneeId: devUserId }).expect(200);
  });
});
