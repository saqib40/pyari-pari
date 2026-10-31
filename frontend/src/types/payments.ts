export type MatchSuggestion = {
  entryId: string;
  customerName: string;
  /** What the entry still owes, in paise. */
  pending: number;
};

/**
 * Money that arrived without an exact match to an entry: on the shop's QR, or
 * more than a payment link asked for. The merchant decides where it goes.
 */
export type QrPayment = {
  id: string;
  source: 'qr' | 'link';
  /** Paise. */
  amount: number;
  /** ISO-8601 timestamp. */
  receivedAt: string;
  /** Open entries this payment may settle, best match first. */
  suggestions: MatchSuggestion[];
};
