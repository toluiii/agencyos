import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvoiceStatus, Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScope } from '../common/decorators/scope.decorator';
import { calculateInvoice, fromMinorUnits, toMinorUnits } from '../common/utils/money';
import { IntegrationsService } from '../integrations/integrations.service';
import { AuditService } from '../common/audit.service';
import { NotificationService } from '../notifications/notifications.service';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto';

@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');
  constructor(private prisma: PrismaService, private config: ConfigService, private integrations: IntegrationsService, private audit: AuditService, private notifications: NotificationService) {}

  private invoiceWhere(s: TenantScope, status?: string): Prisma.InvoiceWhereInput {
    return { organizationId: s.organizationId, ...(s.role === 'CLIENT' ? { clientId: s.clientId ?? '__none__', status: { not: 'DRAFT' } } : {}), ...(status ? { AND: [{ status: status as InvoiceStatus }] } : {}) };
  }
  async list(s: TenantScope, q: { page: number; limit: number; skip: number; q?: string; status?: string; clientId?: string }) {
    const where: Prisma.InvoiceWhereInput = { AND: [this.invoiceWhere(s, q.status), ...(q.clientId ? [{ clientId: q.clientId }] : []), ...(q.q ? [{ OR: [{ number: { contains: q.q, mode: 'insensitive' as const } }, { client: { name: { contains: q.q, mode: 'insensitive' as const } } }] }] : [])] };
    const [data, total] = await Promise.all([this.prisma.invoice.findMany({ where, skip: q.skip, take: q.limit, orderBy: { createdAt: 'desc' }, include: { client: { select: { id: true, name: true } }, project: { select: { id: true, name: true } }, items: true, payments: { where: { status: 'SUCCEEDED' }, select: { amount: true } } } }), this.prisma.invoice.count({ where })]);
    return { data, meta: { total, page: q.page, limit: q.limit, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
  }
  async get(s: TenantScope, id: string) {
    const invoice = await this.prisma.invoice.findFirst({ where: { id, ...this.invoiceWhere(s) }, include: { client: { select: { id: true, name: true, company: true } }, project: { select: { id: true, name: true, budget: true } }, items: true, payments: { orderBy: { createdAt: 'desc' } } } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }
  async create(s: TenantScope, dto: CreateInvoiceDto) {
    const client = await this.prisma.client.findFirst({ where: { id: dto.clientId, organizationId: s.organizationId } });
    if (!client) throw new BadRequestException('Client not found');
    if (dto.projectId) { const p = await this.prisma.project.findFirst({ where: { id: dto.projectId, organizationId: s.organizationId, clientId: dto.clientId } }); if (!p) throw new BadRequestException('Project not found for this client'); }
    const calc = calculateInvoice(dto.items, dto.taxRate ?? 0);
    // Invoice numbers are unique per organization. Two concurrent creates can read the same
    // count, so retry with the next number instead of surfacing a 409 to the user.
    for (let attempt = 0; ; attempt++) {
      const count = await this.prisma.invoice.count({ where: { organizationId: s.organizationId } });
      const number = `INV-${new Date().getFullYear()}-${String(count + 1 + attempt).padStart(4, '0')}`;
      try {
        return await this.prisma.$transaction(async (tx) => {
          const inv = await tx.invoice.create({ data: { organizationId: s.organizationId, clientId: dto.clientId, projectId: dto.projectId, number, currency: (dto.currency ?? 'USD').toUpperCase(), subtotal: calc.subtotal, taxRate: dto.taxRate ?? 0, taxAmount: calc.taxAmount, total: calc.total, dueDate: new Date(dto.dueDate), notes: dto.notes, items: { create: calc.lines.map((l, i) => ({ description: dto.items[i].description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount })) } }, include: { items: true, client: { select: { name: true } } } });
          await tx.auditEvent.create({ data: { organizationId: s.organizationId, actorId: s.userId, action: 'invoice.created', entityType: 'Invoice', entityId: inv.id, metadata: { clientId: dto.clientId, total: calc.total } } });
          return inv;
        });
      } catch (error) {
        if (attempt < 4 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
        throw error;
      }
    }
  }
  /**
   * An invoice's Stripe Checkout session stays payable for 24 hours. Before the invoice changes
   * (edit/void) the open session is expired so the customer cannot pay a stale amount; if the
   * customer already completed it, the change is refused until the webhook marks it paid.
   */
  private async releaseCheckout(invoice: { id: string; stripeSessionId: string | null }) {
    if (!invoice.stripeSessionId) return;
    const session = await this.retrieveCheckout(invoice.stripeSessionId);
    if (session?.status === 'complete') throw new BadRequestException('A payment for this invoice was just completed; wait for it to be confirmed');
    if (session?.status === 'open') {
      try { await this.integrations.getStripe().checkout.sessions.expire(session.id); } catch (error) {
        this.logger.error(JSON.stringify({ event: 'stripe.checkout_expire_failed', invoiceId: invoice.id, error: error instanceof Error ? error.message : String(error) }));
        throw new ServiceUnavailableException({ statusCode: 503, code: 'STRIPE_UNAVAILABLE', message: 'Could not cancel the open payment session. Try again.' });
      }
    }
    await this.prisma.invoice.update({ where: { id: invoice.id }, data: { stripeSessionId: null } });
  }
  private async retrieveCheckout(sessionId: string): Promise<Stripe.Checkout.Session | null> {
    if (!this.config.get<string>('STRIPE_SECRET_KEY')) return null; // Stripe is no longer configured: nothing can be paid or expired.
    try { return await this.integrations.getStripe().checkout.sessions.retrieve(sessionId); } catch (error) {
      if ((error as { code?: string })?.code === 'resource_missing') return null;
      throw new ServiceUnavailableException({ statusCode: 503, code: 'STRIPE_UNAVAILABLE', message: 'Could not check the open payment session. Try again.' });
    }
  }
  async update(s: TenantScope, id: string, dto: UpdateInvoiceDto) {
    const existing = await this.get(s, id);
    if (existing.status === 'PAID') throw new BadRequestException('Paid invoices are immutable');
    if (existing.status === 'VOID' && dto.status !== 'DRAFT') throw new BadRequestException('Void invoices cannot be edited');
    const client = await this.prisma.client.findFirst({ where: { id: dto.clientId, organizationId: s.organizationId } });
    if (!client) throw new BadRequestException('Client not found');
    if (dto.projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: dto.projectId, organizationId: s.organizationId, clientId: dto.clientId } });
      if (!project) throw new BadRequestException('Project not found for this client');
    }
    const calc = calculateInvoice(dto.items, dto.taxRate ?? 0);
    await this.releaseCheckout(existing);
    const invoice = await this.prisma.$transaction(async (tx) => {
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      return tx.invoice.update({ where: { id }, data: { clientId: dto.clientId, projectId: dto.projectId, dueDate: new Date(dto.dueDate), currency: (dto.currency ?? existing.currency).toUpperCase(), subtotal: calc.subtotal, taxRate: dto.taxRate ?? 0, taxAmount: calc.taxAmount, total: calc.total, notes: dto.notes, status: dto.status ?? existing.status, items: { create: calc.lines.map((l, i) => ({ description: dto.items[i].description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount })) } }, include: { items: true } });
    });
    await this.audit.record({ organizationId: s.organizationId, actorId: s.userId, action: 'invoice.updated', entityType: 'Invoice', entityId: id });
    return invoice;
  }
  async send(s: TenantScope, id: string) {
    const invoice = await this.get(s, id);
    if (invoice.status === 'PAID' || invoice.status === 'VOID') throw new BadRequestException('Invoice cannot be sent');
    const updated = await this.prisma.invoice.update({ where: { id }, data: { status: 'SENT' } });
    const members = await this.prisma.membership.findMany({ where: { organizationId: s.organizationId, clientId: invoice.clientId, role: 'CLIENT' }, select: { userId: true } });
    for (const m of members) await this.notifications.notify({ organizationId: s.organizationId, userId: m.userId, type: 'PAYMENT', title: `Invoice ${invoice.number} is ready`, body: `Amount due: ${invoice.currency} ${invoice.total}. Due ${invoice.dueDate.toISOString().slice(0, 10)}.`, link: `/billing/${id}`, email: true });
    await this.audit.record({ organizationId: s.organizationId, actorId: s.userId, action: 'invoice.sent', entityType: 'Invoice', entityId: id });
    return updated;
  }
  async void(s: TenantScope, id: string) {
    const inv = await this.get(s, id); if (inv.status === 'PAID') throw new BadRequestException('Paid invoices cannot be voided');
    await this.releaseCheckout(inv);
    const updated = await this.prisma.invoice.update({ where: { id }, data: { status: 'VOID' } });
    await this.audit.record({ organizationId: s.organizationId, actorId: s.userId, action: 'invoice.voided', entityType: 'Invoice', entityId: id });
    return updated;
  }
  async createCheckout(s: TenantScope, id: string) {
    const invoice = await this.get(s, id);
    if (!['SENT', 'OVERDUE'].includes(invoice.status)) throw new BadRequestException('Only sent or overdue invoices can be paid');
    if (invoice.payments.some((p) => p.status === 'SUCCEEDED')) throw new BadRequestException('Invoice already paid');
    const stripe = this.integrations.getStripe();
    // Reuse a still-open session instead of creating a second payable one (double payment).
    if (invoice.stripeSessionId) {
      const current = await this.retrieveCheckout(invoice.stripeSessionId);
      if (current?.status === 'complete') throw new BadRequestException('A payment for this invoice was just completed; wait for it to be confirmed');
      if (current?.status === 'open' && current.url) return { checkoutUrl: current.url, sessionId: current.id };
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price_data: { currency: invoice.currency.toLowerCase(), unit_amount: toMinorUnits(invoice.total.toString(), invoice.currency), product_data: { name: `Invoice ${invoice.number}` } }, quantity: 1 }],
      success_url: `${this.config.getOrThrow('WEB_URL')}/billing/${id}?payment=success`,
      cancel_url: `${this.config.getOrThrow('WEB_URL')}/billing/${id}?payment=cancelled`,
      client_reference_id: invoice.id,
      metadata: { invoiceId: invoice.id, organizationId: s.organizationId },
      payment_intent_data: { metadata: { invoiceId: invoice.id, organizationId: s.organizationId } },
    });
    await this.prisma.invoice.update({ where: { id }, data: { stripeSessionId: session.id } });
    await this.audit.record({ organizationId: s.organizationId, actorId: s.userId, action: 'invoice.checkout_created', entityType: 'Invoice', entityId: id });
    return { checkoutUrl: session.url, sessionId: session.id };
  }

  async handleStripeWebhook(signature: string | undefined, rawBody: Buffer | undefined) {
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) throw new ServiceUnavailableException({ statusCode: 503, code: 'STRIPE_WEBHOOK_UNAVAILABLE', message: 'Stripe webhook secret is not configured' });
    if (!signature || !rawBody?.length) throw new BadRequestException('Missing Stripe signature or raw body');
    const stripe = this.integrations.getStripe();
    let event: Stripe.Event;
    try { event = stripe.webhooks.constructEvent(rawBody, signature, secret); } catch { throw new BadRequestException('Invalid Stripe webhook signature'); }
    const result = await this.prisma.$transaction(async (tx) => {
      const dedupe = await tx.webhookEvent.createMany({ data: { provider: 'stripe', eventId: event.id, eventType: event.type }, skipDuplicates: true });
      if (dedupe.count === 0) return { received: true, duplicate: true };
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status !== 'paid') return { received: true, duplicate: false, ignored: 'not_paid' };
        const invoiceId = session.metadata?.invoiceId || session.client_reference_id;
        if (!invoiceId) return { received: true, duplicate: false, ignored: 'no_invoice_reference' };
        const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
        if (!invoice) return { received: true, duplicate: false, ignored: 'invoice_not_found' };
        if (session.metadata?.organizationId && session.metadata.organizationId !== invoice.organizationId) throw new BadRequestException('Webhook organization mismatch');
        const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        // Compare in the currency's minor units (see toMinorUnits) and require the same currency:
        // the invoice can be edited after a checkout session was created.
        if (session.currency && session.currency.toUpperCase() !== invoice.currency.toUpperCase()) throw new BadRequestException('Webhook currency mismatch');
        if ((session.amount_total ?? -1) !== toMinorUnits(invoice.total.toString(), invoice.currency)) throw new BadRequestException('Webhook amount mismatch');
        const amount = fromMinorUnits(session.amount_total ?? 0, invoice.currency);
        await tx.payment.upsert({ where: { providerPaymentId: paymentIntentId ?? `session_${session.id}` }, create: { organizationId: invoice.organizationId, invoiceId: invoice.id, amount, currency: (session.currency ?? invoice.currency).toUpperCase(), status: 'SUCCEEDED', provider: 'stripe', providerEventId: event.id, providerPaymentId: paymentIntentId ?? `session_${session.id}`, metadata: { sessionId: session.id } }, update: { status: 'SUCCEEDED' } });
        await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'PAID', paidAt: new Date() } });
        await tx.auditEvent.create({ data: { organizationId: invoice.organizationId, action: 'payment.succeeded', entityType: 'Invoice', entityId: invoice.id, metadata: { amount, eventId: event.id } } });
        return { received: true, duplicate: false, invoiceId: invoice.id, paid: true };
      }
      if (event.type === 'checkout.session.async_payment_failed' || event.type === 'payment_intent.payment_failed') {
        const obj = event.data.object as any;
        const invoiceId = obj.metadata?.invoiceId;
        if (invoiceId) {
          const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
          // A failed statement aborts the whole PostgreSQL transaction (including the dedupe row),
          // so never "create().catch()" inside it: upsert on the unique provider id instead.
          const providerPaymentId = (typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id) ?? obj.id;
          if (invoice) await tx.payment.upsert({ where: { providerPaymentId }, create: { organizationId: invoice.organizationId, invoiceId: invoice.id, amount: Number(invoice.total), currency: invoice.currency, status: 'FAILED', provider: 'stripe', providerEventId: event.id, providerPaymentId, metadata: { eventType: event.type } }, update: {} });
        }
        return { received: true, duplicate: false, failed: true };
      }
      if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        const sub = event.data.object as Stripe.Subscription;
        const orgId = sub.metadata?.organizationId;
        if (orgId) {
          const status = sub.status === 'active' ? 'ACTIVE' : sub.status === 'past_due' ? 'PAST_DUE' : sub.status === 'trialing' ? 'TRIALING' : 'CANCELED';
          await tx.subscription.updateMany({ where: { organizationId: orgId }, data: { status: status as any, stripeSubscriptionId: sub.id, stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id, currentPeriodEnd: new Date((sub as any).current_period_end * 1000) } });
        }
        return { received: true, duplicate: false, subscriptionUpdated: !!orgId };
      }
      return { received: true, duplicate: false, ignored: event.type };
    });
    if ('paid' in result && result.paid && result.invoiceId) {
      const invoice = await this.prisma.invoice.findUniqueOrThrow({ where: { id: result.invoiceId }, include: { client: { select: { name: true } } } });
      await this.notifications.notifyRoles(invoice.organizationId, ['OWNER', 'MANAGER'], { type: 'PAYMENT', title: `Payment received: ${invoice.number}`, body: `${invoice.client.name} paid ${invoice.currency} ${invoice.total}.`, link: `/billing/${invoice.id}`, dedupeKey: `paid:${invoice.id}`, email: true });
    }
    this.logger.log(JSON.stringify({ event: 'stripe.webhook', type: event.type, eventId: event.id, result }));
    return result;
  }

  async createSubscriptionCheckout(s: TenantScope) {
    const priceId = this.config.get<string>('STRIPE_PRICE_ID');
    if (!priceId) throw new ServiceUnavailableException({ statusCode: 503, code: 'STRIPE_PRICE_UNAVAILABLE', message: 'STRIPE_PRICE_ID is not configured' });
    const stripe = this.integrations.getStripe();
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: s.organizationId }, include: { subscription: true } });
    const session = await stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price: priceId, quantity: 1 }], success_url: `${this.config.getOrThrow('WEB_URL')}/settings?subscription=success`, cancel_url: `${this.config.getOrThrow('WEB_URL')}/settings?subscription=cancelled`, client_reference_id: org.id, metadata: { organizationId: org.id }, subscription_data: { metadata: { organizationId: org.id } } });
    return { checkoutUrl: session.url };
  }
  async subscription(s: TenantScope) { return this.prisma.subscription.findUnique({ where: { organizationId: s.organizationId } }); }
  async outstanding(s: TenantScope) {
    const invoices = await this.prisma.invoice.findMany({ where: { organizationId: s.organizationId, status: { in: ['SENT', 'OVERDUE'] } }, include: { client: { select: { name: true } } }, orderBy: { dueDate: 'asc' } });
    const total = invoices.reduce((sum, i) => sum + Number(i.total), 0);
    const byCurrency = new Map<string, number>();
    for (const i of invoices) byCurrency.set(i.currency, (byCurrency.get(i.currency) ?? 0) + Number(i.total));
    // `total` mixes currencies and is kept only for compatibility; use `totals` instead.
    return { count: invoices.length, total: Math.round(total * 100) / 100, totals: Array.from(byCurrency, ([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })), invoices };
  }
}
