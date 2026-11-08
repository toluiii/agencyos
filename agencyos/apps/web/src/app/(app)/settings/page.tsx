'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CheckCircle2, XCircle, CreditCard, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { useToastMutation } from '@/hooks/use-mutation-toast';
import type { AuditEvent, IntegrationStatus, Organization, Subscription } from '@/lib/types';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { FormField } from '@/components/shared/form-field';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StatusBadge } from '@/components/shared/status-badge';
import { formatDate } from '@/lib/utils';
import { setActiveOrg } from '@/lib/api';
const orgSchema = z.object({ name: z.string().min(2), description: z.string().optional() });
function SettingsInner() {
  const { org, role, refresh, isManagement } = useAuth(); const params = useSearchParams(); const [newOrgOpen, setNewOrgOpen] = useState(params.get('newOrg') === '1');
  const integrations = useQuery({ queryKey: ['integrations', org?.id], queryFn: () => api<IntegrationStatus>('/integrations/status'), enabled: !!org && isManagement, retry: false });
  const sub = useQuery({ queryKey: ['subscription', org?.id], queryFn: () => api<Subscription | null>('/billing/subscription'), enabled: !!org && role !== 'CLIENT' });
  const audit = useQuery({ queryKey: ['audit', org?.id], queryFn: () => api<AuditEvent[]>('/audit'), enabled: !!org && role === 'OWNER', retry: false });
  const form = useForm<z.infer<typeof orgSchema>>({ resolver: zodResolver(orgSchema), values: org ? { name: org.name, description: org.description ?? '' } : undefined });
  const newOrgForm = useForm<z.infer<typeof orgSchema>>({ resolver: zodResolver(orgSchema) });
  const update = useToastMutation({ mutationFn: (d: z.infer<typeof orgSchema>) => api(`/organizations/${org!.id}`, { method: 'PATCH', body: JSON.stringify(d) }), success: 'Organization updated', invalidate: [['organizations']], onSuccess: refresh });
  const createOrg = useToastMutation({ mutationFn: (d: z.infer<typeof orgSchema>) => api<Organization>('/organizations', { method: 'POST', body: JSON.stringify(d), orgId: null }), success: 'Organization created', invalidate: [['organizations']], onSuccess: async (o) => { setActiveOrg(o.id); await refresh(); setNewOrgOpen(false); } });
  const checkout = useToastMutation({ mutationFn: () => api<{ checkoutUrl: string }>('/billing/subscription/checkout', { method: 'POST', body: '{}' }), onSuccess: (r) => { if (r.checkoutUrl) window.location.href = r.checkoutUrl; } });
  const runReminders = useToastMutation({ mutationFn: () => api<{ candidates: number; created: number }>('/notifications/run-reminders', { method: 'POST', body: '{}' }), success: 'Reminder job executed', invalidate: [['notifications-all'], ['notifications']] });
  if (!org) return null;
  const rows = integrations.data ? [
    { name: 'Stripe payments', ok: integrations.data.stripe.configured, detail: integrations.data.stripe.configured ? `Webhook ${integrations.data.stripe.webhookConfigured ? 'configured' : 'not configured'}` : 'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET' },
    { name: 'OpenAI assistant', ok: integrations.data.openai.configured, detail: integrations.data.openai.configured ? `Model ${integrations.data.openai.model}` : 'Set OPENAI_API_KEY' },
    { name: 'Resend email', ok: integrations.data.email.configured, detail: integrations.data.email.configured ? 'Delivery enabled' : 'Set RESEND_API_KEY; emails are skipped and logged' },
    { name: 'Object storage', ok: true, detail: integrations.data.storage.provider === 's3' ? `S3 bucket ${integrations.data.storage.bucket}` : 'Local disk (development). Configure S3_* for object storage' },
    { name: 'Error monitoring', ok: integrations.data.errorMonitoring.configured, detail: integrations.data.errorMonitoring.configured ? 'Sentry DSN configured' : 'Optional SENTRY_DSN integration point' },
  ] : [];
  return <div><PageHeader title="Settings" description="Organization configuration, integrations, subscription, and audit." actions={role === 'OWNER' && <Button variant="outline" onClick={() => setNewOrgOpen(true)}><Plus />New organization</Button>} />
    <Tabs defaultValue="general"><TabsList><TabsTrigger value="general">General</TabsTrigger><TabsTrigger value="integrations">Integrations</TabsTrigger>{role !== 'CLIENT' && <TabsTrigger value="subscription">Subscription</TabsTrigger>}{role === 'OWNER' && <TabsTrigger value="audit">Audit log</TabsTrigger>}</TabsList>
      <TabsContent value="general"><Card className="max-w-xl"><CardHeader><CardTitle>Organization</CardTitle><CardDescription>Slug: {org.slug}</CardDescription></CardHeader><CardContent><form method="post" onSubmit={form.handleSubmit((d) => update.mutate(d))} className="space-y-4"><FormField label="Name" required><Input {...form.register('name')} disabled={role !== 'OWNER'} /></FormField><FormField label="Description"><Textarea {...form.register('description')} disabled={role !== 'OWNER'} /></FormField>{role === 'OWNER' && <Button type="submit" loading={update.isPending}>Save changes</Button>}</form></CardContent></Card></TabsContent>
      <TabsContent value="integrations"><Card><CardHeader><CardTitle>Third-party services</CardTitle><CardDescription>Configuration status is reported by the API. Missing credentials produce explicit unavailable states, never simulated success.</CardDescription></CardHeader><CardContent className="space-y-2">{!isManagement ? <p className="text-sm text-muted-foreground">Manager access required.</p> : integrations.isError ? <p className="text-sm text-destructive">{integrations.error.message}</p> : rows.map((r) => <div key={r.name} className="flex items-center justify-between rounded-md border p-3"><div className="flex items-center gap-3">{r.ok ? <CheckCircle2 className="h-5 w-5 text-success" /> : <XCircle className="h-5 w-5 text-warning" />}<div><p className="text-sm font-medium">{r.name}</p><p className="text-xs text-muted-foreground">{r.detail}</p></div></div><Badge variant={r.ok ? 'success' : 'warning'}>{r.ok ? 'Configured' : 'Not configured'}</Badge></div>)}{isManagement && <div className="pt-3"><Button variant="outline" onClick={() => runReminders.mutate()} loading={runReminders.isPending}>Run deadline reminder job now</Button><p className="mt-1 text-xs text-muted-foreground">The same job runs hourly via NestJS schedule.</p></div>}</CardContent></Card></TabsContent>
      <TabsContent value="subscription"><Card className="max-w-xl"><CardHeader><CardTitle>Plan</CardTitle><CardDescription>Seat limits are enforced when inviting agency members.</CardDescription></CardHeader><CardContent className="space-y-4">{sub.data ? <><div className="flex items-center justify-between rounded-md border p-4"><div><p className="font-semibold capitalize">{sub.data.plan}</p><p className="text-sm text-muted-foreground">{sub.data.seatLimit} agency seats · {sub.data.currentPeriodEnd ? `renews ${formatDate(sub.data.currentPeriodEnd)}` : 'trial'}</p></div><StatusBadge status={sub.data.status} /></div>{role === 'OWNER' && <Button onClick={() => checkout.mutate()} loading={checkout.isPending}><CreditCard />Manage subscription via Stripe</Button>}<p className="text-xs text-muted-foreground">Requires STRIPE_SECRET_KEY and STRIPE_PRICE_ID. Subscription state changes are applied by verified webhooks.</p></> : <p className="text-sm text-muted-foreground">No subscription record.</p>}</CardContent></Card></TabsContent>
      {role === 'OWNER' && <TabsContent value="audit"><Card><CardHeader><CardTitle>Audit events</CardTitle><CardDescription>Latest 30 organization events</CardDescription></CardHeader><CardContent className="space-y-2">{audit.isError ? <p className="text-sm text-destructive">{audit.error.message}</p> : audit.data?.length ? audit.data.map((a) => <div key={a.id} className="flex items-center justify-between rounded-md border p-3 text-sm"><div><p className="font-medium">{a.action}</p><p className="text-xs text-muted-foreground">{a.entityType} · {a.actor?.name ?? 'System'}</p></div><span className="text-xs text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</span></div>) : <p className="text-sm text-muted-foreground">No audit events.</p>}</CardContent></Card></TabsContent>}
    </Tabs>
    <Dialog open={newOrgOpen} onOpenChange={setNewOrgOpen}><DialogContent><DialogHeader><DialogTitle>Create organization</DialogTitle></DialogHeader><form method="post" onSubmit={newOrgForm.handleSubmit((d) => createOrg.mutate(d))} className="space-y-4"><FormField label="Name" required><Input {...newOrgForm.register('name')} /></FormField><FormField label="Description"><Textarea {...newOrgForm.register('description')} /></FormField><DialogFooter><Button type="submit" loading={createOrg.isPending}>Create</Button></DialogFooter></form></DialogContent></Dialog>
  </div>;
}
export default function SettingsPage() { return <Suspense><SettingsInner /></Suspense>; }
