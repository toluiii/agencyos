import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { OrgGuard } from '../common/guards/org.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Scope, TenantScope } from '../common/decorators/scope.decorator';
import { Public } from '../common/decorators/public.decorator';
import { BillingService } from './billing.service';
import { CreateInvoiceDto, InvoiceQueryDto, UpdateInvoiceDto } from './dto';
@ApiTags('Billing') @Controller('billing')
export class BillingController {
  constructor(private service: BillingService) {}
  @ApiBearerAuth() @UseGuards(OrgGuard, RolesGuard) @Get('invoices') list(@Scope() s: TenantScope, @Query() q: InvoiceQueryDto) { return this.service.list(s, { page: q.page, limit: q.limit, skip: q.skip, q: q.q, status: q.status, clientId: q.clientId }); }
  @ApiBearerAuth() @UseGuards(OrgGuard, RolesGuard) @Get('invoices/outstanding') @Roles('OWNER', 'MANAGER') outstanding(@Scope() s: TenantScope) { return this.service.outstanding(s); }
  @ApiBearerAuth() @UseGuards(OrgGuard, RolesGuard) @Get('invoices/:id') get(@Scope() s: TenantScope, @Param('id') id: string) { return this.service.get(s, id); }
  @ApiBearerAuth() @UseGuards(OrgGuard, RolesGuard) @Roles('OWNER', 'MANAGER') @Post('invoices') create(@Scope() s: TenantScope, @Body() dto: CreateInvoiceDto) { return this.service.create(s, dto); }
  @ApiBearerAuth() @UseGuards(OrgGuard, RolesGuard) @Roles('OWNER', 'MANAGER') @Patch('invoices/:id') update(@Scope() s: TenantScope, @Param('id') id: string, @Body() dto: UpdateInvoiceDto) { return this.service.update(s, id, dto); }
  @ApiBearerAuth() @UseGuards(OrgGuard, RolesGuard) @Roles('OWNER', 'MANAGER') @Post('invoices/:id/send') send(@Scope() s: TenantScope, @Param('id') id: string) { return this.service.send(s, id); }
  @ApiBearerAuth() @UseGuards(OrgGuard, RolesGuard) @Roles('OWNER', 'MANAGER') @Post('invoices/:id/void') void(@Scope() s: TenantScope, @Param('id') id: string) { return this.service.void(s, id); }
  @ApiBearerAuth() @UseGuards(OrgGuard, RolesGuard) @Post('invoices/:id/checkout') checkout(@Scope() s: TenantScope, @Param('id') id: string) { return this.service.createCheckout(s, id); }
  @ApiBearerAuth() @UseGuards(OrgGuard, RolesGuard) @Roles('OWNER', 'MANAGER', 'DEVELOPER') @Get('subscription') subscription(@Scope() s: TenantScope) { return this.service.subscription(s); }
  @ApiBearerAuth() @UseGuards(OrgGuard, RolesGuard) @Roles('OWNER') @Post('subscription/checkout') subCheckout(@Scope() s: TenantScope) { return this.service.createSubscriptionCheckout(s); }
  @Public() @SkipThrottle() @Post('webhooks/stripe') webhook(@Headers('stripe-signature') signature: string | undefined, @Req() req: Request) { return this.service.handleStripeWebhook(signature, (req as any).rawBody); }
}
