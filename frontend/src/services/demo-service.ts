import { api } from './api-client';

// Stand-ins for a customer paying, like the CLI's L and Q keys. The backend only offers them with
// PARI_PAYTM_MODE=mock, and runs them through the same reconciler as real Paytm callbacks.

export function simulateLinkPaid(entryId: string) {
  return api.post('/dev/simulate/link-paid', { entryId });
}

export function simulateQrPayment(amountRupees: number) {
  return api.post('/dev/simulate/qr', { amountRupees });
}
