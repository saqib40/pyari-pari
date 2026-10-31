import { useSyncExternalStore } from 'react';

import { fetchConversationState } from '@/services/conversation-service';
import { speak } from '@/services/speech-service';
import type { ConversationState, Line } from '@/types/api';
import type { LedgerEntry, PaymentLink } from '@/types/ledger';

/** Pari's latest turn, kept outside the Listen tab so events and other tabs can update it. */
export type Turn = {
  /** Changes with every turn, so the screen can animate the new one in. */
  id: number;
  state: ConversationState;
  /** Missing until Pari has said something. */
  reply?: Line;
  /** What Pari heard, when the merchant spoke. */
  transcript?: string;
  entry?: LedgerEntry;
  link?: PaymentLink;
  needsReview?: boolean;
};

let turn: Turn = { id: 0, state: 'IDLE' };
const listeners = new Set<() => void>();
/** Payment news that arrived while Pari was waiting for an answer. */
const heldBack: Line[] = [];

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTurn() {
  return turn;
}

export function useTurn() {
  return useSyncExternalStore(subscribe, getTurn, getTurn);
}

/** Shows a turn and says its reply, then any news held back while Pari waited for an answer. */
export function showTurn(next: Omit<Turn, 'id'>) {
  turn = { ...next, id: turn.id + 1 };
  listeners.forEach((listener) => listener());
  if (next.reply) speak(next.reply);
  if (next.state === 'IDLE') heldBack.splice(0).forEach(speak);
}

/** Payment news: said now, or after the question Pari is waiting on. */
export function announce(line: Line, entry?: LedgerEntry) {
  if (turn.state === 'IDLE') showTurn({ state: 'IDLE', reply: line, entry });
  else heldBack.push(line);
}

/** A QR payment was settled by tap. If Pari had asked about it aloud, the server has dropped that question. */
export async function settleByTap(line: Line, entry?: LedgerEntry) {
  if (turn.state === 'AWAITING_QR_MATCH') {
    const { state } = await fetchConversationState();
    if (state === 'IDLE') {
      showTurn({ state: 'IDLE', reply: line, entry });
      return;
    }
  }
  announce(line, entry);
}
