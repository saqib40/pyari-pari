import type { MatchResponse, SuggestionDto } from '@/types/api';
import type { QrPayment } from '@/types/payments';

import { api } from './api-client';
import { toPaise } from './ledger-service';

function toQrPayment({ payment, candidates }: SuggestionDto): QrPayment {
  return {
    id: payment.id,
    source: payment.source === 'LINK' ? 'link' : 'qr',
    amount: toPaise(payment.amountRupees),
    receivedAt: payment.createdAt,
    suggestions: candidates.map(({ entry }) => ({
      entryId: entry.id,
      customerName: entry.customer.name,
      pending: toPaise(entry.pendingRupees),
    })),
  };
}

/** Payments waiting for the merchant to say which entry they belong to, oldest first. */
export async function fetchQrPayments(signal?: AbortSignal): Promise<QrPayment[]> {
  const { suggestions } = await api.get<{ suggestions: SuggestionDto[] }>('/payments/suggestions', signal);
  return suggestions.map(toQrPayment);
}

export function matchQrPayment(paymentId: string, entryId: string) {
  return api.post<MatchResponse>(`/payments/${paymentId}/match`, { entryId });
}

/** The payment isn't for any open entry, so it stays out of the ledger. */
export function dismissQrPayment(paymentId: string) {
  return api.post<MatchResponse>(`/payments/${paymentId}/match`, { reject: true });
}
