import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { JwtModule } from '@nestjs/jwt';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AuditModule } from './common/audit.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { MembershipsModule } from './memberships/memberships.module';
import { ClientsModule } from './clients/clients.module';
import { ProjectsModule } from './projects/projects.module';
import { TasksModule } from './tasks/tasks.module';
import { MilestonesModule } from './milestones/milestones.module';
import { CommentsModule } from './comments/comments.module';
import { DocumentsModule } from './documents/documents.module';
import { SupportModule } from './support/support.module';
import { BillingModule } from './billing/billing.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AiModule } from './ai/ai.module';
import { AdminModule } from './admin/admin.module';
import { HealthModule } from './health/health.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { IntegrationsController } from './integrations/integrations.controller';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { CsrfGuard } from './common/guards/csrf.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, envFilePath: ['../../.env', '.env'] }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 240 }]),
    ScheduleModule.forRoot(),
    JwtModule.register({}),
    PrismaModule, IntegrationsModule, AuditModule, AuthModule, UsersModule, OrganizationsModule, MembershipsModule, ClientsModule, ProjectsModule, TasksModule, MilestonesModule, CommentsModule, DocumentsModule, SupportModule, BillingModule, NotificationsModule, AnalyticsModule, AiModule, AdminModule, HealthModule, MaintenanceModule,
  ],
  controllers: [IntegrationsController],

  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
