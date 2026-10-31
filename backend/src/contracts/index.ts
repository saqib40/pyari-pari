/**
 * Request schemas and response shapes shared by every client (CLI now, web/mobile later).
 * Keep this file free of server-only imports so a frontend can copy or import it as-is.
 */
import { z } from "zod";

export const ENTRY_STATUSES = ["UNCONFIRMED", "OPEN", "CLOSED", "REJECTED"] as const;
export type EntryStatusDto = (typeof ENTRY_STATUSES)[number];

export const CONVERSATION_STATES = [
  "IDLE",
  "AWAITING_ENTRY_CONFIRM",
  "AWAITING_COLLECT_CHOICE",
  "AWAITING_PHONE",
  "AWAITING_PHONE_CONFIRM",
  "AWAITING_QR_MATCH",
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

const rupees = z.number().nonnegative().max(10_000_000).multipleOf(0.01);

// ------------------------------------------------------------------ requests

export const ConverseTextBody = z.object({
  text: z.string().trim().min(1).max(2000),
  speak: z.boolean().default(true),
});
export type ConverseTextBody = z.input<typeof ConverseTextBody>;

export const VoiceEntryTextBody = z.object({
  text: z.string().trim().min(1).max(2000),
  speak: z.boolean().default(true),
});

export const ConfirmBody = z.object({ answer: z.enum(["yes", "no"]) });

export const PatchEntryBody = z
  .object({
    customerName: z.string().trim().min(1).max(100).optional(),
    totalRupees: rupees.optional(),
    paidRupees: rupees.optional(),
    pendingRupees: rupees.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

export const CollectBody = z.object({ phone: z.string().trim().min(10).max(20).optional() });

export const MatchBody = z.union([
  z.object({ entryId: z.string().min(4) }),
  z.object({ reject: z.literal(true) }),
]);

export const TtsBody = z.object({ text: z.string().trim().min(1).max(2500) });

export const ListEntriesQuery = z.object({
  status: z.enum(ENTRY_STATUSES).optional(),
  customerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const SimulateLinkPaidBody = z
  .object({
    entryId: z.string().min(4).optional(),
    orderId: z.string().min(4).optional(),
    amountRupees: rupees.positive().optional(),
  })
  .refine((b) => b.entryId || b.orderId, "entryId or orderId is required");

export const SimulateQrBody = z.object({
  amountRupees: rupees.positive(),
  payerName: z.string().trim().min(1).max(100).optional(),
});

// ----------------------------------------------------------------- responses

/** What Pari says. `text` is for display (Roman Hinglish), `speech` is what Bulbul reads. */
export interface Line {
  text: string;
  speech: string;
}

export interface CustomerDto {
  id: string;
  name: string;
  phone: string | null;
}

export interface EntryDto {
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
}

export interface LinkDto {
  id: string;
  orderId: string;
  entryId: string;
  amountRupees: number;
  shortUrl: string | null;
  phone: string;
  status: "ACTIVE" | "PAID" | "EXPIRED" | "FAILED";
  createdAt: string;
}

export interface PaymentDto {
  id: string;
  source: "LINK" | "QR";
  txnId: string;
  orderId: string | null;
  amountRupees: number;
  payerName: string | null;
  entryId: string | null;
  matchStatus: "MATCHED" | "SUGGESTED" | "UNMATCHED" | "REJECTED";
  createdAt: string;
}

/** An entry as the ledger lists it: with its latest payment link and the payments matched to it. */
export interface LedgerEntryDto extends EntryDto {
  link: LinkDto | null;
  payments: PaymentDto[];
}

export interface CandidateDto {
  entry: EntryDto;
  score: number;
  reason: string;
}

export interface SuggestionDto {
  payment: PaymentDto;
  candidates: CandidateDto[];
}

export interface ConverseResponse {
  sessionId: string;
  state: ConversationState;
  transcript?: string;
  reply: Line;
  /** base64 WAV of `reply.speech`; omitted when the request asked for speak=false. */
  replyAudio?: string;
  entry?: EntryDto;
  link?: LinkDto;
  needsReview?: boolean;
  /** Server-side milliseconds per stage, for latency feedback. */
  timings?: { sttMs?: number; thinkMs: number; ttsMs?: number };
}

export interface VoiceEntryResponse {
  transcript: string;
  entry: EntryDto;
  readback: Line;
  readbackAudio?: string;
  needsReview: boolean;
  unverifiedFields: string[];
}

export interface MerchantDto {
  id: string;
  name: string;
  /** null until PARI_UPI_ID is set. */
  upiId: string | null;
  /** What the shop QR encodes: a UPI payment intent when upiId is set, otherwise just the shop name. */
  qrPayload: string;
}

export interface SttResponse {
  transcript: string;
  languageCode: string | null;
}

export interface BalanceResponse {
  customer: CustomerDto;
  pendingRupees: number;
  openEntries: EntryDto[];
}

export interface CollectResponse {
  link: LinkDto;
  entry: EntryDto;
  line: Line;
}

export interface MatchResponse {
  payment: PaymentDto;
  entry?: EntryDto;
  line: Line;
}

export type PariEventDto =
  | { type: "entry.updated"; entry: EntryDto }
  | { type: "payment.received"; payment: PaymentDto; entry?: EntryDto; line: Line }
  | { type: "payment.suggested"; suggestion: SuggestionDto }
  | { type: "pari.prompt"; state: ConversationState; line: Line }
  | { type: "pari.announce"; line: Line };

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
