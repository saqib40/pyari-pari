/**
 * Response shapes of the Pari backend, copied from backend/src/contracts/index.ts.
 * Amounts are rupees here; the services convert them to paise for the screens.
 */

export type EntryStatusDto = 'UNCONFIRMED' | 'OPEN' | 'CLOSED' | 'REJECTED';

export type ConversationState =
  | 'IDLE'
  | 'AWAITING_ENTRY_CONFIRM'
  | 'AWAITING_COLLECT_CHOICE'
  | 'AWAITING_PHONE'
  | 'AWAITING_PHONE_CONFIRM'
  | 'AWAITING_QR_MATCH';

/** What Pari says. `text` is for display (Roman Hinglish), `speech` is what Bulbul reads. */
export type Line = {
  text: string;
  speech: string;
};

export type CustomerDto = {
  id: string;
  name: string;
  phone: string | null;
};

export type EntryDto = {
  id: string;
  shortId: string;
  customer: CustomerDto;
  totalRupees: number;
  paidRupees: number;
  pendingRupees: number;
  status: EntryStatusDto;
  needsReview: boolean;
  transcript: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LinkDto = {
  id: string;
  orderId: string;
  entryId: string;
  amountRupees: number;
  shortUrl: string | null;
  phone: string;
  status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'FAILED';
  createdAt: string;
};

export type PaymentDto = {
  id: string;
  source: 'LINK' | 'QR';
  txnId: string;
  orderId: string | null;
  amountRupees: number;
  payerName: string | null;
  entryId: string | null;
  matchStatus: 'MATCHED' | 'SUGGESTED' | 'UNMATCHED' | 'REJECTED';
  createdAt: string;
};

export type LedgerEntryDto = EntryDto & {
  link: LinkDto | null;
  payments: PaymentDto[];
};

export type CandidateDto = {
  entry: EntryDto;
  score: number;
  reason: string;
};

export type SuggestionDto = {
  payment: PaymentDto;
  candidates: CandidateDto[];
};

export type MerchantDto = {
  id: string;
  name: string;
  upiId: string | null;
  qrPayload: string;
};

export type ConverseResponse = {
  sessionId: string;
  state: ConversationState;
  transcript?: string;
  reply: Line;
  entry?: EntryDto;
  link?: LinkDto;
  needsReview?: boolean;
};

export type ConverseStateResponse = {
  sessionId: string;
  state: ConversationState;
  entryId: string | null;
};

export type MatchResponse = {
  payment: PaymentDto;
  entry?: EntryDto;
  line: Line;
};

export type PariEventDto =
  | { type: 'entry.updated'; entry: EntryDto }
  | { type: 'payment.received'; payment: PaymentDto; entry?: EntryDto; line: Line }
  | { type: 'payment.suggested'; suggestion: SuggestionDto }
  | { type: 'pari.prompt'; state: ConversationState; line: Line }
  | { type: 'pari.announce'; line: Line };

export type ApiErrorBody = {
  error: { code: string; message: string; details?: unknown };
};
