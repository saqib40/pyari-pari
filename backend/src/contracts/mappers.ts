import type { Customer, Merchant, Payment, PaymentLink } from "../db/types.js";
import type { EntryHistory, EntryWithCustomer } from "../ledger/repository.js";
import { toRupees } from "../ledger/state.js";
import type { CustomerDto, EntryDto, LedgerEntryDto, LinkDto, MerchantDto, PaymentDto } from "./index.js";

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function toCustomerDto(c: Pick<Customer, "id" | "name" | "phone">): CustomerDto {
  return { id: c.id, name: c.name, phone: c.phone };
}

export function toEntryDto(e: EntryWithCustomer): EntryDto {
  return {
    id: e.id,
    shortId: e.id.slice(0, 8),
    customer: { id: e.customer_id, name: e.customer_name, phone: e.customer_phone },
    totalRupees: toRupees(e.total_paise),
    paidRupees: toRupees(e.paid_paise),
    pendingRupees: toRupees(e.pending_paise),
    status: e.status,
    needsReview: e.needs_review,
    transcript: e.transcript,
    createdAt: iso(e.created_at),
    updatedAt: iso(e.updated_at),
  };
}

export function toLedgerEntryDto(e: EntryWithCustomer, history: EntryHistory): LedgerEntryDto {
  return {
    ...toEntryDto(e),
    link: history.link ? toLinkDto(history.link) : null,
    payments: history.payments.map(toPaymentDto),
  };
}

export function toLinkDto(l: PaymentLink): LinkDto {
  return {
    id: l.id,
    orderId: l.order_id,
    entryId: l.entry_id,
    amountRupees: toRupees(l.amount_paise),
    shortUrl: l.short_url,
    phone: l.phone,
    status: l.status,
    createdAt: iso(l.created_at),
  };
}

export function toPaymentDto(p: Payment): PaymentDto {
  return {
    id: p.id,
    source: p.source,
    txnId: p.txn_id,
    orderId: p.order_id,
    amountRupees: toRupees(p.amount_paise),
    payerName: p.payer_name,
    entryId: p.entry_id,
    matchStatus: p.match_status,
    createdAt: iso(p.created_at),
  };
}

export function toMerchantDto(m: Merchant, upiId: string | undefined): MerchantDto {
  return {
    id: m.id,
    name: m.name,
    upiId: upiId ?? null,
    qrPayload: upiId ? `upi://pay?pa=${upiId}&pn=${encodeURIComponent(m.name)}&cu=INR` : m.name,
  };
}
