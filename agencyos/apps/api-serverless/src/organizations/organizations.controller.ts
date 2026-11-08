import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { CreateOrganizationDto, UpdateOrganizationDto } from './dto';
import { OrgGuard } from '../common/guards/org.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Scope, TenantScope } from '../common/decorators/scope.decorator';
import { AuditService } from '../common/audit.service';
import { slugify } from '../common/utils/security';
@ApiTags('Organizations') @ApiBearerAuth() @Controller('organizations')
export class OrganizationsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}
  @Get() async list(@CurrentUser() user: AuthUser) {
    const memberships = await this.prisma.membership.findMany({ where: { userId: user.id }, include: { organization: { include: { subscription: true, _count: { select: { clients: true, projects: true, memberships: true } } } } }, orderBy: { createdAt: 'asc' } });
    // Client portal users see which agency they belong to, not its plan, seats or volumes.
    return { data: memberships.map((m) => { const { subscription, _count, ...org } = m.organization; return { ...org, ...(m.role === 'CLIENT' ? {} : { subscription, _count }), role: m.role, clientId: m.clientId }; }) };
  }
  @Post() async create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrganizationDto) {
    let slug = slugify(dto.name); let n = 1;
    while (await this.prisma.organization.findUnique({ where: { slug } })) slug = `${slugify(dto.name)}-${++n}`;
    const org = await this.prisma.organization.create({ data: { name: dto.name, slug, description: dto.description, memberships: { create: { userId: user.id, role: 'OWNER' } }, subscription: { create: {} } } });
    await this.audit.record({ organizationId: org.id, actorId: user.id, action: 'organization.created', entityType: 'Organization', entityId: org.id });
    return org;
  }
  @Get(':orgId') @UseGuards(OrgGuard) get(@Param('orgId') orgId: string, @Scope() scope: TenantScope) {
    if (scope.role === 'CLIENT') return this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true, name: true, slug: true, description: true } });
    return this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, include: { subscription: true, _count: { select: { clients: true, projects: true, memberships: true, invoices: true } } } });
  }
  @Patch(':orgId') @UseGuards(OrgGuard, RolesGuard) @Roles('OWNER') async update(@Scope() scope: TenantScope, @Body() dto: UpdateOrganizationDto) {
    const org = await this.prisma.organization.update({ where: { id: scope.organizationId }, data: dto });
    await this.audit.record({ organizationId: org.id, actorId: scope.userId, action: 'organization.updated', entityType: 'Organization', entityId: org.id });
    return org;
  }
}
