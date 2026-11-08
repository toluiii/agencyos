'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowUpRight, FolderKanban } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { useChartColors } from '@/lib/use-chart-colors';
import type { Dashboard } from '@/lib/types';
import { PageHeader } from '@/components/shared/page-header';
import { MetricLedger, MetricLedgerSkeleton } from '@/components/shared/metric-ledger';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { formatDate, formatMoney, formatMoneyTotals, titleCase } from '@/lib/utils';

export default function DashboardPage() {
  const { org, isClient } = useAuth();
  const colors = useChartColors();
  const q = useQuery({
    queryKey: ['dashboard', org?.id],
    queryFn: () => api<Dashboard>('/analytics/dashboard'),
    enabled: !!org,
  });

  const header = (
    <PageHeader
      title={isClient ? 'Your projects' : 'Operations'}
      description={
        isClient
          ? 'Delivery progress, invoices, and support activity for your account.'
          : 'Delivery and finance figures for this workspace, computed from live records.'
      }
      actions={
        !isClient && (
          <Button asChild variant="outline">
            <Link href="/projects">
              Open projects
              <ArrowUpRight aria-hidden />
            </Link>
          </Button>
        )
      }
    />
  );

  if (q.isPending) {
    return (
      <div>
        {header}
        <MetricLedgerSkeleton count={isClient ? 4 : 6} />
        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-72 lg:col-span-2" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  // One failing widget must not blank the page: the header stays, the failure is local.
  if (q.isError) {
    return (
      <div>
        {header}
        <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />
      </div>
    );
  }

  const d = q.data;
  const k = d.kpis;
  const metrics = isClient
    ? [
        { label: 'Active projects', value: k.activeProjects, hint: `${k.totalProjects} total`, href: '/projects' },
        { label: 'Completion', value: `${k.completionRate}%`, hint: 'Tasks completed' },
        { label: 'Outstanding', value: formatMoneyTotals(k.outstandingByCurrency, k.outstanding), hint: 'Unpaid invoices', href: '/billing', attention: k.outstanding > 0 },
        { label: 'Open tickets', value: k.openTickets, hint: 'Awaiting a reply', href: '/support' },
      ]
    : [
        { label: 'Active projects', value: k.activeProjects, hint: `${k.totalProjects} total`, href: '/projects' },
        { label: 'Completion', value: `${k.completionRate}%`, hint: 'Tasks completed' },
        { label: 'Overdue tasks', value: k.overdueTasks, hint: k.overdueTasks ? 'Past their due date' : 'Nothing late', href: '/tasks', attention: k.overdueTasks > 0 },
        { label: 'Revenue · 6 mo', value: formatMoneyTotals(k.revenueByCurrency, k.revenue), hint: 'Succeeded payments' },
        { label: 'Outstanding', value: formatMoneyTotals(k.outstandingByCurrency, k.outstanding), hint: 'Unpaid invoices', href: '/billing', attention: k.overdueTasks === 0 && k.outstanding > 0 },
        { label: 'Open tickets', value: k.openTickets, hint: 'Awaiting a reply', href: '/support' },
      ];

  const noRevenue = d.revenueByMonth.every((m) => m.revenue === 0);

  return (
    <div>
      {header}
      <MetricLedger metrics={metrics} />

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Revenue</CardTitle>
            <CardDescription>Succeeded payments, last six months. {isClient ? 'Your invoices only.' : 'All workspace payments.'}</CardDescription>
          </CardHeader>
          <CardContent className="h-64 sm:h-72">
            {noRevenue ? (
              <EmptyState
                icon={FolderKanban}
                title="No payments in this period"
                description="Revenue appears here once an invoice is paid. Issued but unpaid invoices are counted as outstanding."
                className="h-full justify-center border-0 bg-transparent p-0"
              />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={d.revenueByMonth} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={colors.accent} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={colors.grid} vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: colors.axis }} stroke={colors.grid} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 11, fill: colors.axis }}
                    stroke={colors.grid}
                    tickLine={false}
                    width={48}
                    tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`}
                  />
                  <Tooltip
                    formatter={(v) => formatMoney(Number(v))}
                    contentStyle={{
                      background: colors.surface,
                      border: `1px solid ${colors.grid}`,
                      borderRadius: 8,
                      fontSize: 12,
                      color: colors.text,
                    }}
                    labelStyle={{ color: colors.axis }}
                    cursor={{ stroke: colors.grid }}
                  />
                  <Area type="monotone" dataKey="revenue" stroke={colors.accent} strokeWidth={2} fill="url(#revenueFill)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tasks by status</CardTitle>
            <CardDescription>Across projects you can see</CardDescription>
          </CardHeader>
          <CardContent className="h-64 sm:h-72">
            {d.tasksByStatus.length === 0 ? (
              <EmptyState
                icon={FolderKanban}
                title="No tasks yet"
                description="Tasks created in any visible project are counted here."
                className="h-full justify-center border-0 bg-transparent p-0"
              />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.tasksByStatus} layout="vertical" margin={{ left: 4, right: 12 }}>
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="status"
                    width={88}
                    tick={{ fontSize: 11, fill: colors.axis }}
                    stroke={colors.grid}
                    tickLine={false}
                    tickFormatter={(v) => titleCase(String(v))}
                  />
                  <Tooltip
                    contentStyle={{
                      background: colors.surface,
                      border: `1px solid ${colors.grid}`,
                      borderRadius: 8,
                      fontSize: 12,
                      color: colors.text,
                    }}
                    cursor={{ fill: colors.grid, opacity: 0.4 }}
                  />
                  <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                    {d.tasksByStatus.map((_, i) => (
                      <Cell key={i} fill={colors.status[d.tasksByStatus[i].status] ?? colors.series[i % colors.series.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent projects</CardTitle>
            <CardDescription>Progress is computed from task completion</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {d.recentProjects.length === 0 ? (
              <EmptyState
                icon={FolderKanban}
                title="No projects yet"
                description="Projects you create or are assigned to appear here with their progress and due date."
                action={
                  !isClient && (
                    <Button asChild size="sm">
                      <Link href="/projects">Create a project</Link>
                    </Button>
                  )
                }
              />
            ) : (
              d.recentProjects.map((p) => (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className="block rounded-md border border-border p-3 transition-colors duration-fast hover:bg-sunken"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="mt-0.5 truncate text-xs text-ink-muted">
                        {p.client} · due {formatDate(p.dueDate)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={p.status} />
                      {p.overdue > 0 && (
                        <span className="text-xs font-medium text-danger">{p.overdue} overdue</span>
                      )}
                    </div>
                  </div>
                  <div className="mt-2.5 flex items-center gap-3">
                    <Progress value={p.progress} className="flex-1" />
                    <span data-figure className="w-9 text-end font-mono text-xs text-ink-muted">
                      {p.progress}%
                    </span>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{isClient ? 'Account summary' : 'Team workload'}</CardTitle>
            <CardDescription>{isClient ? 'Totals for your account' : 'Open tasks per member'}</CardDescription>
          </CardHeader>
          <CardContent>
            {isClient ? (
              <dl className="divide-y divide-border text-sm">
                {[
                  ['Projects', k.totalProjects],
                  ['Outstanding', formatMoneyTotals(k.outstandingByCurrency, k.outstanding)],
                  ['Open tickets', k.openTickets],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex items-center justify-between py-2.5">
                    <dt className="text-ink-muted">{label}</dt>
                    <dd data-figure className="font-mono font-medium">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : d.workload.length === 0 ? (
              <EmptyState
                icon={FolderKanban}
                title="No team members"
                description="Invite colleagues from the Team page to see their workload here."
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href="/team">Open team</Link>
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y divide-border text-sm">
                {d.workload.map((w) => (
                  <li key={w.userId} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="truncate">{w.name}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span data-figure className="font-mono text-xs text-ink-muted">
                        {w.openTasks} open
                      </span>
                      {w.overdue > 0 && (
                        <span data-figure className="rounded-xs border border-danger/25 bg-danger/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-danger">
                          {w.overdue} late
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 border-t border-border pt-3 text-xs text-ink-faint">
              Generated{' '}
              <time dateTime={d.generatedAt}>
                {new Date(d.generatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </time>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
