'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CreditCard, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { useToastMutation } from '@/hooks/use-mutation-toast';
import type { Client, Invoice, Paginated, Subscription } from '@/lib/types';
import { PageHeader } from '@/components/shared/page-header';
import { SearchInput } from '@/components/shared/search-input';
import { DataPagination } from '@/components/shared/data-pagination';
import { StatusBadge } from '@/components/shared/status-badge';
import { StatCard } from '@/components/shared/stat-card';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FormField } from '@/components/shared/form-field';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, formatMoney, formatMoneyTotals, totalsByCurrency } from '@/lib/utils';
const itemSchema = z.object({ description: z.string().min(1), quantity: z.coerce.number().int().min(1), unitPrice: z.coerce.number().min(0) });
const schema = z.object({ clientId: z.string().min(1, 'Select a client'), projectId: z.string().optional(), dueDate: z.string().min(1, 'Due date required'), taxRate: z.coerce.number().min(0).max(100), currency: z.string().length(3), notes: z.string().optional(), items: z.array(itemSchema).min(1) });
type Form = z.infer<typeof schema>;
export default function BillingPage() {
  const { org, isManagement, isClient } = useAuth(); const [page, setPage] = useState(1); const [q, setQ] = useState(''); const [status, setStatus] = useState('all'); const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['invoices', org?.id, page, q, status], queryFn: () => api<Paginated<Invoice>>(`/billing/invoices?page=${page}&limit=15&q=${encodeURIComponent(q)}${status !== 'all' ? `&status=${status}` : ''}`), enabled: !!org });
  const sub = useQuery({ queryKey: ['subscription', org?.id], queryFn: () => api<Subscription | null>('/billing/subscription'), enabled: !!org && !isClient });
  const clients = useQuery({ queryKey: ['clients-all', org?.id], queryFn: () => api<Paginated<Client>>('/clients?limit=100'), enabled: !!org && isManagement && open });
  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { clientId: '', dueDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), taxRate: 0, currency: 'USD', items: [{ description: '', quantity: 1, unitPrice: 0 }] } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'items' });
  const create = useToastMutation({ mutationFn: (d: Form) => api<Invoice>('/billing/invoices', { method: 'POST', body: JSON.stringify({ ...d, projectId: d.projectId || undefined }) }), success: 'Invoice created', invalidate: [['invoices'], ['dashboard']], onSuccess: () => { setOpen(false); form.reset(); } });
  const items = form.watch('items'); const tax = form.watch('taxRate') || 0; const subtotal = items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0);
  const all = query.data?.data ?? []; const outstandingList = all.filter((i) => ['SENT', 'OVERDUE'].includes(i.status)); const outstanding = totalsByCurrency(outstandingList); const paid = totalsByCurrency(all.filter((i) => i.status === 'PAID'));
  return <div><PageHeader title={isClient ? 'Invoices' : 'Billing'} description={isClient ? 'Review and pay invoices from your agency.' : 'Invoices, payments, and subscription.'} actions={isManagement && <Button onClick={() => setOpen(true)}><Plus />New invoice</Button>} />
    {!isClient && <div className="mb-6 grid gap-4 sm:grid-cols-3"><StatCard label="Paid (this page)" value={formatMoneyTotals(paid)} icon={CreditCard} /><StatCard label="Outstanding (this page)" value={formatMoneyTotals(outstanding)} icon={AlertTriangle} trend={outstandingList.length ? 'down' : 'neutral'} /><StatCard label="Subscription" value={sub.data ? `${sub.data.plan} · ${sub.data.status}` : '—'} hint={sub.data ? `${sub.data.seatLimit} seats` : undefined} icon={CreditCard} /></div>}
    <div className="mb-4 flex flex-col gap-2 sm:flex-row"><SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search invoice number or client…" /><Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}><SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger><SelectContent>{['all', 'DRAFT', 'SENT', 'PAID', 'OVERDUE', 'VOID'].map((s) => <SelectItem key={s} value={s}>{s === 'all' ? 'All statuses' : s}</SelectItem>)}</SelectContent></Select></div>
    {query.isLoading ? <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14" />)}</div> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : all.length === 0 ? <EmptyState icon={CreditCard} title="No invoices" description={isClient ? 'Invoices sent to you will appear here.' : 'Create an invoice to start tracking payments.'} action={isManagement && <Button onClick={() => setOpen(true)}><Plus />New invoice</Button>} /> : <Card><Table hideBelow={{ md: [2, 3, 5] }}><TableHeader><TableRow><TableHead>Invoice</TableHead><TableHead>Client</TableHead><TableHead>Project</TableHead><TableHead>Status</TableHead><TableHead>Due</TableHead><TableHead className="text-right">Total</TableHead></TableRow></TableHeader><TableBody>{all.map((i) => <TableRow key={i.id}><TableCell><Link href={`/billing/${i.id}`} className="font-medium hover:text-primary">{i.number}</Link></TableCell><TableCell className="text-sm">{i.client.name}</TableCell><TableCell className="text-sm text-muted-foreground">{i.project?.name ?? '—'}</TableCell><TableCell><StatusBadge status={i.status} /></TableCell><TableCell className={i.status === 'OVERDUE' ? 'text-destructive text-sm' : 'text-sm'}>{formatDate(i.dueDate)}</TableCell><TableCell className="text-right font-medium">{formatMoney(i.total, i.currency)}</TableCell></TableRow>)}</TableBody></Table><div className="px-3 pb-3"><DataPagination page={query.data!.meta.page} totalPages={query.data!.meta.totalPages} total={query.data!.meta.total} onChange={setPage} /></div></Card>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>New invoice</DialogTitle></DialogHeader><form method="post" onSubmit={form.handleSubmit((d) => create.mutate(d))} className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><FormField label="Client" required error={form.formState.errors.clientId?.message}><Select value={form.watch('clientId')} onValueChange={(v) => form.setValue('clientId', v)}><SelectTrigger><SelectValue placeholder="Select client" /></SelectTrigger><SelectContent>{clients.data?.data.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select></FormField><FormField label="Due date" required error={form.formState.errors.dueDate?.message}><Input type="date" {...form.register('dueDate')} /></FormField></div><div className="grid gap-4 sm:grid-cols-2"><FormField label="Currency"><Select value={form.watch('currency')} onValueChange={(v) => form.setValue('currency', v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{['USD', 'EUR', 'GBP', 'TND'].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select></FormField><FormField label="Tax rate (%)" error={form.formState.errors.taxRate?.message}><Input type="number" min={0} max={100} step="0.01" {...form.register('taxRate')} /></FormField></div>
      <div className="space-y-2"><p className="text-sm font-medium">Line items</p>{fields.map((f, idx) => <div key={f.id} className="grid grid-cols-12 gap-2"><Input className="col-span-6" placeholder="Description" {...form.register(`items.${idx}.description`)} /><Input className="col-span-2" type="number" min={1} placeholder="Qty" {...form.register(`items.${idx}.quantity`)} /><Input className="col-span-3" type="number" min={0} step="0.01" placeholder="Unit price" {...form.register(`items.${idx}.unitPrice`)} /><Button type="button" variant="ghost" size="icon" className="col-span-1" onClick={() => remove(idx)} disabled={fields.length === 1} aria-label="Remove item"><Trash2 /></Button></div>)}<Button type="button" variant="outline" size="sm" onClick={() => append({ description: '', quantity: 1, unitPrice: 0 })}><Plus />Add item</Button></div>
      <div className="rounded-md bg-muted/50 p-3 text-sm"><div className="flex justify-between"><span>Subtotal</span><span>{formatMoney(subtotal, form.watch('currency'))}</span></div><div className="flex justify-between"><span>Tax ({tax}%)</span><span>{formatMoney(subtotal * tax / 100, form.watch('currency'))}</span></div><div className="flex justify-between font-semibold"><span>Total</span><span>{formatMoney(subtotal * (1 + tax / 100), form.watch('currency'))}</span></div></div><FormField label="Notes"><Textarea {...form.register('notes')} /></FormField><DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={create.isPending}>Create draft</Button></DialogFooter></form></DialogContent></Dialog>
  </div>;
}
