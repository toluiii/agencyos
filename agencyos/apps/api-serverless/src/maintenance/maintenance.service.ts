import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const DAY = 86400000;

/**
 * Retention for tables that otherwise grow forever. Audit events are deliberately kept.
 *
 * Refresh sessions are deleted only once their token has expired (the JWT has the same TTL, so it
 * can no longer be presented). Revoked-but-unexpired rows must stay: refresh-token reuse
 * detection depends on finding them.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger('Maintenance');
  constructor(private prisma: PrismaService) {}

  /** Long-running server only; on Vercel the cron endpoint calls purgeExpiredRecords(). */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async scheduledPurge() {
    if (process.env.VERCEL) return;
    await this.purgeExpiredRecords().catch((error) => this.logger.error(JSON.stringify({ event: 'retention_failed', error: error instanceof Error ? error.message : String(error) })));
  }

  async purgeExpiredRecords(now = new Date()) {
    const before = (days: number) => new Date(now.getTime() - days * DAY);
    const [refreshSessions, resetTokens, invitations, notifications, webhookEvents] = await this.prisma.$transaction([
      this.prisma.refreshSession.deleteMany({ where: { expiresAt: { lt: before(1) } } }),
      this.prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: before(1) } } }),
      this.prisma.invitation.deleteMany({ where: { acceptedAt: null, expiresAt: { lt: before(30) } } }),
      this.prisma.notification.deleteMany({ where: { readAt: { lt: before(90) } } }),
      // Stripe retries a webhook for up to three days; 90 days of dedupe history is ample.
      this.prisma.webhookEvent.deleteMany({ where: { processedAt: { lt: before(90) } } }),
    ]);
    const result = { refreshSessions: refreshSessions.count, resetTokens: resetTokens.count, invitations: invitations.count, notifications: notifications.count, webhookEvents: webhookEvents.count };
    this.logger.log(JSON.stringify({ event: 'retention_purge', ...result }));
    return result;
  }
}
