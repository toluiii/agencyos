import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScope } from '../common/decorators/scope.decorator';
import { ProjectsService, progressOf } from '../projects/projects.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService, private projects: ProjectsService) {}
  async dashboard(s: TenantScope) {
    const orgId = s.organizationId;
    const now = new Date();
    const projectWhere = this.projects.projectWhere(s);
    const clientWhere = { organizationId: orgId, ...(s.role === 'CLIENT' ? { id: s.clientId ?? '__none__' } : {}) };
    const taskWhere = { organizationId: orgId, project: projectWhere };
    const invoiceWhere = { organizationId: orgId, ...(s.role === 'CLIENT' ? { clientId: s.clientId ?? '__none__', status: { not: 'DRAFT' as const } } : {}) };
    const openInvoiceWhere = { ...invoiceWhere, status: { in: ['SENT' as const, 'OVERDUE' as const] } };
    // Month buckets are computed in UTC so they line up with the UTC timestamps they are matched against.
    const firstMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
    const [activeProjects, totalProjects, totalTasks, doneTasks, overdueTasks, totalClients, activeClients, openTickets, outstandingAgg, overdueInvoices, payments, recentProjects, agencyMembers, projectPerformance, tasksByStatus] = await Promise.all([
      this.prisma.project.count({ where: { ...projectWhere, status: 'ACTIVE' } }),
      this.prisma.project.count({ where: projectWhere }),
      this.prisma.task.count({ where: taskWhere }),
      this.prisma.task.count({ where: { ...taskWhere, status: 'DONE' } }),
      this.prisma.task.count({ where: { ...taskWhere, status: { not: 'DONE' }, dueDate: { lt: now } } }),
      this.prisma.client.count({ where: clientWhere }),
      this.prisma.client.count({ where: { ...clientWhere, status: 'ACTIVE' } }),
      this.prisma.supportTicket.count({ where: { organizationId: orgId, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_CLIENT'] }, ...(s.role === 'CLIENT' ? { clientId: s.clientId ?? '__none__' } : {}) } }),
      // Aggregated in SQL; this used to load every invoice of the organization on each dashboard view.
      this.prisma.invoice.groupBy({ by: ['currency'], where: openInvoiceWhere, _sum: { total: true } }),
      this.prisma.invoice.count({ where: { ...openInvoiceWhere, dueDate: { lt: now } } }),
      this.prisma.payment.findMany({ where: { organizationId: orgId, status: 'SUCCEEDED', createdAt: { gte: firstMonth }, ...(s.role === 'CLIENT' ? { invoice: { clientId: s.clientId ?? '__none__' } } : {}) }, select: { amount: true, currency: true, createdAt: true } }),
      this.prisma.project.findMany({ where: projectWhere, orderBy: { updatedAt: 'desc' }, take: 6, select: { id: true, name: true, status: true, dueDate: true, client: { select: { name: true } } } }),
      s.role === 'CLIENT' ? Promise.resolve([]) : this.prisma.user.findMany({ where: { memberships: { some: { organizationId: orgId, role: { in: ['OWNER', 'MANAGER', 'DEVELOPER'] } } } }, select: { id: true, name: true } }),
      this.prisma.project.findMany({ where: projectWhere, take: 50, orderBy: { updatedAt: 'desc' }, select: { id: true, name: true, status: true, dueDate: true, budget: true, client: { select: { name: true } } } }),
      this.prisma.task.groupBy({ by: ['status'], where: taskWhere, _count: { _all: true } }),
    ]);
    // Per-project and per-assignee counts are grouped in SQL instead of loading every task row.
    const stats = await this.projects.taskStats(Array.from(new Set([...recentProjects, ...projectPerformance].map((p) => p.id))));
    const workloadRows = agencyMembers.length ? await Promise.all([
      this.prisma.task.groupBy({ by: ['assigneeId', 'priority'], where: { organizationId: orgId, status: { not: 'DONE' }, assigneeId: { in: agencyMembers.map((u) => u.id) } }, _count: { _all: true } }),
      this.prisma.task.groupBy({ by: ['assigneeId'], where: { organizationId: orgId, status: { not: 'DONE' }, dueDate: { lt: now }, assigneeId: { in: agencyMembers.map((u) => u.id) } }, _count: { _all: true } }),
    ]) : [[], []] as const;
    const workload = agencyMembers.map((u) => {
      const rows = workloadRows[0].filter((r) => r.assigneeId === u.id);
      return { userId: u.id, name: u.name, openTasks: rows.reduce((n, r) => n + r._count._all, 0), urgent: rows.filter((r) => r.priority === 'URGENT' || r.priority === 'HIGH').reduce((n, r) => n + r._count._all, 0), overdue: workloadRows[1].find((r) => r.assigneeId === u.id)?._count._all ?? 0 };
    });
    const revenue = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const outstanding = outstandingAgg.reduce((sum, row) => sum + Number(row._sum.total ?? 0), 0);
    // Amounts in different currencies cannot be added up meaningfully; expose them per currency.
    // `revenue` / `outstanding` remain as plain sums for backward compatibility.
    const outstandingByCurrency = outstandingAgg.map((row) => ({ currency: row.currency, amount: Math.round(Number(row._sum.total ?? 0) * 100) / 100 })).sort((a, b) => b.amount - a.amount);
    const revenueTotals = new Map<string, number>();
    for (const p of payments) revenueTotals.set(p.currency, (revenueTotals.get(p.currency) ?? 0) + Number(p.amount));
    const revenueByCurrency = Array.from(revenueTotals, ([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);
    const revenueByMonth: { month: string; revenue: number }[] = [];
    for (let i = 5; i >= 0; i--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); const key = d.toISOString().slice(0, 7); revenueByMonth.push({ month: key, revenue: Math.round(payments.filter((p) => p.createdAt.toISOString().slice(0, 7) === key).reduce((sum, p) => sum + Number(p.amount), 0) * 100) / 100 }); }
    const summary = (p: { id: string; name: string; status: string; dueDate: Date | null; client: { name: string } }) => { const st = stats.get(p.id) ?? { taskCount: 0, doneCount: 0, overdueCount: 0 }; return { id: p.id, name: p.name, client: p.client.name, status: p.status, progress: progressOf(st), overdue: st.overdueCount, dueDate: p.dueDate }; };
    return {
      kpis: { activeProjects, totalProjects, completionRate: totalTasks ? Math.round(doneTasks / totalTasks * 100) : 0, overdueTasks, totalClients, activeClients, openTickets, revenue: Math.round(revenue * 100) / 100, outstanding: Math.round(outstanding * 100) / 100, overdueInvoices, revenueByCurrency, outstandingByCurrency },
      revenueByMonth,
      tasksByStatus: tasksByStatus.map((t) => ({ status: t.status, count: t._count._all })),
      recentProjects: recentProjects.map(summary),
      workload,
      projectPerformance: projectPerformance.map((p) => ({ ...summary(p), budget: p.budget ? Number(p.budget) : null })),
      generatedAt: now.toISOString(),
    };
  }
}
