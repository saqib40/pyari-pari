import type { EntryDto, EntryStatusDto, LedgerEntryDto, LinkDto } from '@/types/api';
import type { EntryStatus, LedgerEntry, Payment, PaymentLink } from '@/types/ledger';

import { api } from './api-client';

export const toPaise = (rupees: number) => Math.round(rupees * 100);

const STATUS: Record<EntryStatusDto, EntryStatus> = {
  UNCONFIRMED: 'unconfirmed',
  OPEN: 'open',
  CLOSED: 'closed',
  REJECTED: 'rejected',
};

/** Only a link that is still waiting or got paid says anything about the entry. */
export function toPaymentLink(link: LinkDto): PaymentLink | undefined {
  if (link.status !== 'ACTIVE' && link.status !== 'PAID') return undefined;
  return {
    amount: toPaise(link.amountRupees),
    phone: link.phone,
    status: link.status === 'PAID' ? 'paid' : 'sent',
    sentAt: link.createdAt,
  };
}

/** Without history (a conversation turn), the entry shows only what was paid when it was spoken. */
export function toLedgerEntry(dto: EntryDto | LedgerEntryDto): LedgerEntry {
  const later: Payment[] =
    'payments' in dto
      ? dto.payments.map((p) => ({
          amount: toPaise(p.amountRupees),
          method: p.source === 'LINK' ? 'link' : 'qr',
          at: p.createdAt,
        }))
      : [];
  const paid = toPaise(dto.paidRupees);
  const atCounter = Math.max(0, paid - later.reduce((sum, p) => sum + p.amount, 0));
  const link = 'link' in dto && dto.link ? toPaymentLink(dto.link) : undefined;

  return {
    id: dto.id,
    customer: { id: dto.customer.id, name: dto.customer.name, phone: dto.customer.phone ?? undefined },
    total: toPaise(dto.totalRupees),
    paid,
    pending: toPaise(dto.pendingRupees),
    status: STATUS[dto.status],
    needsReview: dto.needsReview,
    payments: [...(atCounter > 0 ? [{ amount: atCounter, method: 'counter' as const, at: dto.createdAt }] : []), ...later],
    link,
    createdAt: dto.createdAt,
    closedAt: dto.status === 'CLOSED' ? dto.updatedAt : undefined,
  };
}

/** Everything the merchant has said yes to; drafts and cancelled entries are left out. */
export async function fetchLedgerEntries(signal?: AbortSignal): Promise<LedgerEntry[]> {
  const { entries } = await api.get<{ entries: LedgerEntryDto[] }>('/entries?limit=200', signal);
  return entries.filter((e) => e.status === 'OPEN' || e.status === 'CLOSED').map(toLedgerEntry);
}
