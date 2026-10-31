import { randomUUID } from "node:crypto";
import type { ConversationState, EntryDto, Line, LinkDto, SuggestionDto } from "../contracts/index.js";
import { toEntryDto } from "../contracts/mappers.js";
import type { EventBus } from "../events/bus.js";
import { AppError } from "../helpers/errors.js";
import type { Logger } from "../helpers/logger.js";
import type { EntryExtractor } from "../llm/extractor.js";
import { detectYesNo, type YesNo } from "../llm/intent.js";
import { mentionsNumber, parseIndianMobile } from "../llm/numbers.js";
import { lines } from "../llm/readback.js";
import type { CollectService } from "../ledger/collect.js";
import type { Reconciler } from "../ledger/reconciler.js";
import {
  confirmEntry,
  createUnconfirmedEntry,
  findOrCreateCustomer,
  getEntry,
  listCustomers,
  rejectEntry,
  updateUnconfirmedEntry,
  type Db,
  type EntryWithCustomer,
} from "../ledger/repository.js";
import { toPaise, toRupees } from "../ledger/state.js";

interface QrTurn {
  paymentId: string;
  amountRupees: number;
  candidateEntryIds: string[];
  index: number;
}

export interface Session {
  id: string;
  merchantId: string;
  state: ConversationState;
  entryId: string | null;
  phone: string | null;
  qr: QrTurn | null;
  updatedAt: number;
}

export interface TurnResult {
  sessionId: string;
  state: ConversationState;
  reply: Line;
  entry?: EntryDto;
  link?: LinkDto;
  needsReview?: boolean;
}

interface Deps {
  db: Db;
  extractor: EntryExtractor;
  reconciler: Reconciler;
  collect: CollectService;
  events: EventBus;
  logger?: Logger;
}

type Step = Omit<TurnResult, "sessionId" | "state"> & { state: ConversationState };

/**
 * Server-side dialogue so every client (CLI, web, mobile) only sends what the
 * merchant said and plays back what Pari answers.
 */
export class ConversationEngine {
  private readonly sessions = new Map<string, Session>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: Deps,
    private readonly ttlMs = 120_000,
  ) {
    deps.events.subscribeAll((merchantId, event) => {
      if (event.type === "payment.suggested") {
        void this.withLock(merchantId, () => this.offerSuggestion(merchantId, event.suggestion)).catch((err) =>
          deps.logger?.error({ err }, "could not start QR turn"),
        );
      }
    });
  }

  getSession(merchantId: string): Session {
    let session = this.sessions.get(merchantId);
    if (!session) {
      session = { id: randomUUID(), merchantId, state: "IDLE", entryId: null, phone: null, qr: null, updatedAt: Date.now() };
      this.sessions.set(merchantId, session);
    } else if (session.state !== "IDLE" && Date.now() - session.updatedAt > this.ttlMs) {
      this.toIdle(session);
    }
    return session;
  }

  reset(merchantId: string): Session {
    this.sessions.delete(merchantId);
    return this.getSession(merchantId);
  }

  /** The merchant settled this payment by tap, so a pending spoken question about it is dropped. */
  releasePayment(merchantId: string, paymentId: string): Promise<void> {
    return this.withLock(merchantId, async () => {
      const session = this.sessions.get(merchantId);
      if (session?.state === "AWAITING_QR_MATCH" && session.qr?.paymentId === paymentId) {
        this.toIdle(session);
        session.updatedAt = Date.now();
      }
    });
  }

  handle(merchantId: string, text: string): Promise<TurnResult> {
    return this.withLock(merchantId, async () => {
      const session = this.getSession(merchantId);
      let step = await this.dispatch(session, text.trim());
      if (step.state === "IDLE") {
        const qr = await this.nextQrQuestion(session);
        if (qr) step = { ...step, state: qr.state, reply: lines.join(step.reply, qr.reply) };
      }
      session.state = step.state;
      session.updatedAt = Date.now();
      return { sessionId: session.id, ...step };
    });
  }

  private async withLock<T>(merchantId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(merchantId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.locks.set(merchantId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(merchantId) === run) this.locks.delete(merchantId);
    }
  }

  private toIdle(session: Session): void {
    session.state = "IDLE";
    session.entryId = null;
    session.phone = null;
    session.qr = null;
  }

  private async dispatch(session: Session, text: string): Promise<Step> {
    const answer = detectYesNo(text);
    switch (session.state) {
      case "IDLE":
        return this.newEntry(session, text);
      case "AWAITING_ENTRY_CONFIRM":
        return this.onEntryConfirm(session, text, answer);
      case "AWAITING_COLLECT_CHOICE":
        return this.onCollectChoice(session, text, answer);
      case "AWAITING_PHONE":
        return this.onPhone(session, text, answer);
      case "AWAITING_PHONE_CONFIRM":
        return this.onPhoneConfirm(session, text, answer);
      case "AWAITING_QR_MATCH":
        return this.onQrAnswer(session, answer);
    }
  }

  // ------------------------------------------------------------- entry flow

  private async newEntry(session: Session, text: string): Promise<Step> {
    const result = await this.extract(session.merchantId, text);
    if (result.kind === "not_entry") return { state: "IDLE", reply: lines.notAnEntry() };
    if (result.kind === "unclear") return { state: "IDLE", reply: lines.amountsUnclear() };

    const { customer } = await findOrCreateCustomer(this.deps.db, session.merchantId, result.extraction.customerName);
    const entry = await createUnconfirmedEntry(this.deps.db, {
      merchantId: session.merchantId,
      customerId: customer.id,
      totalPaise: toPaise(result.extraction.totalRupees),
      paidPaise: toPaise(result.extraction.paidRupees),
      pendingPaise: toPaise(result.extraction.pendingRupees),
      transcript: text,
      language: null,
      needsReview: result.needsReview,
    });
    session.entryId = entry.id;
    return {
      state: "AWAITING_ENTRY_CONFIRM",
      reply: lines.entryReadback(amountsOf(entry), result.needsReview),
      entry: toEntryDto(entry),
      needsReview: result.needsReview,
    };
  }

  private async onEntryConfirm(session: Session, text: string, answer: YesNo): Promise<Step> {
    const entryId = session.entryId!;
    if (answer === "yes") {
      const entry = await confirmEntry(this.deps.db, session.merchantId, entryId);
      this.deps.events.publish(session.merchantId, { type: "entry.updated", entry: toEntryDto(entry) });
      if (entry.status === "CLOSED") {
        this.toIdle(session);
        return { state: "IDLE", reply: lines.savedClosed(), entry: toEntryDto(entry) };
      }
      return { state: "AWAITING_COLLECT_CHOICE", reply: lines.savedAskCollect(toRupees(entry.pending_paise)), entry: toEntryDto(entry) };
    }

    if (mentionsNumber(text)) {
      const corrected = await this.correctEntry(session, text);
      if (corrected) return corrected;
    }
    if (answer === "no") {
      const entry = await rejectEntry(this.deps.db, session.merchantId, entryId);
      this.toIdle(session);
      return { state: "IDLE", reply: lines.entryRejected(), entry: toEntryDto(entry) };
    }
    return { state: "AWAITING_ENTRY_CONFIRM", reply: lines.notUnderstoodYesNo() };
  }

  /** "Nahi, 300 ka tha" while confirming: re-read the amounts and ask again. */
  private async correctEntry(session: Session, text: string): Promise<Step | null> {
    const result = await this.extract(session.merchantId, text);
    if (result.kind !== "entry") return null;
    const { customer } = await findOrCreateCustomer(this.deps.db, session.merchantId, result.extraction.customerName);
    const entry = await updateUnconfirmedEntry(this.deps.db, session.merchantId, session.entryId!, {
      customerId: customer.id,
      totalPaise: toPaise(result.extraction.totalRupees),
      paidPaise: toPaise(result.extraction.paidRupees),
      pendingPaise: toPaise(result.extraction.pendingRupees),
      needsReview: result.needsReview,
      transcript: text,
    });
    return {
      state: "AWAITING_ENTRY_CONFIRM",
      reply: lines.entryCorrected(amountsOf(entry), result.needsReview),
      entry: toEntryDto(entry),
      needsReview: result.needsReview,
    };
  }

  // ----------------------------------------------------------- collect flow

  private async onCollectChoice(session: Session, text: string, answer: YesNo): Promise<Step> {
    const entry = await getEntry(this.deps.db, session.merchantId, session.entryId!);
    const spokenPhone = parseIndianMobile(text);
    if (answer === "no") {
      this.toIdle(session);
      return { state: "IDLE", reply: lines.collectDeclined(), entry: toEntryDto(entry) };
    }
    if (spokenPhone) {
      session.phone = spokenPhone;
      return { state: "AWAITING_PHONE_CONFIRM", reply: lines.phoneReadback(spokenPhone) };
    }
    if (answer === "yes") {
      if (entry.customer_phone) return this.sendLink(session, entry.customer_phone);
      return { state: "AWAITING_PHONE", reply: lines.askPhone(entry.customer_name) };
    }
    return { state: "AWAITING_COLLECT_CHOICE", reply: lines.notUnderstoodYesNo() };
  }

  private async onPhone(session: Session, text: string, answer: YesNo): Promise<Step> {
    const phone = parseIndianMobile(text);
    if (phone) {
      session.phone = phone;
      return { state: "AWAITING_PHONE_CONFIRM", reply: lines.phoneReadback(phone) };
    }
    if (answer === "no") {
      this.toIdle(session);
      return { state: "IDLE", reply: lines.collectDeclined() };
    }
    return { state: "AWAITING_PHONE", reply: lines.phoneInvalid() };
  }

  private async onPhoneConfirm(session: Session, text: string, answer: YesNo): Promise<Step> {
    const newPhone = parseIndianMobile(text);
    if (newPhone && newPhone !== session.phone) {
      session.phone = newPhone;
      return { state: "AWAITING_PHONE_CONFIRM", reply: lines.phoneReadback(newPhone) };
    }
    if (answer === "yes") return this.sendLink(session, session.phone!);
    if (answer === "no") {
      session.phone = null;
      return { state: "AWAITING_PHONE", reply: lines.phoneRetry() };
    }
    return { state: "AWAITING_PHONE_CONFIRM", reply: lines.notUnderstoodYesNo() };
  }

  private async sendLink(session: Session, phone: string): Promise<Step> {
    try {
      const res = await this.deps.collect.sendLink(session.merchantId, session.entryId!, phone);
      this.toIdle(session);
      return { state: "IDLE", reply: res.line, entry: res.entry, link: res.link };
    } catch (err) {
      if (err instanceof AppError && err.code.startsWith("PAYTM_")) {
        this.deps.logger?.warn({ err }, "link creation failed");
        this.toIdle(session);
        return { state: "IDLE", reply: lines.linkFailed() };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- QR flow

  private async offerSuggestion(merchantId: string, suggestion: SuggestionDto): Promise<void> {
    const session = this.getSession(merchantId);
    if (session.state !== "IDLE" || suggestion.candidates.length === 0) return;
    const step = this.startQrTurn(session, suggestion);
    session.state = step.state;
    session.updatedAt = Date.now();
    this.deps.events.publish(merchantId, { type: "pari.prompt", state: step.state, line: step.reply });
  }

  private async nextQrQuestion(session: Session): Promise<Step | null> {
    const suggestions = await this.deps.reconciler.getSuggestions(session.merchantId);
    const next = suggestions.find((s) => s.candidates.length > 0);
    return next ? this.startQrTurn(session, next) : null;
  }

  private startQrTurn(session: Session, suggestion: SuggestionDto): Step {
    const first = suggestion.candidates[0]!;
    session.qr = {
      paymentId: suggestion.payment.id,
      amountRupees: suggestion.payment.amountRupees,
      candidateEntryIds: suggestion.candidates.map((c) => c.entry.id),
      index: 0,
    };
    return {
      state: "AWAITING_QR_MATCH",
      reply: lines.qrAsk(suggestion.payment.amountRupees, first.entry.customer.name, first.entry.pendingRupees),
      entry: first.entry,
    };
  }

  private async onQrAnswer(session: Session, answer: YesNo): Promise<Step> {
    const qr = session.qr!;
    const entryId = qr.candidateEntryIds[qr.index]!;
    if (answer === "yes") {
      const res = await this.deps.reconciler.matchPayment(session.merchantId, qr.paymentId, entryId);
      this.toIdle(session);
      return { state: "IDLE", reply: res.line, ...(res.entry ? { entry: res.entry } : {}) };
    }
    if (answer === "no") {
      qr.index += 1;
      const nextId = qr.candidateEntryIds[qr.index];
      if (nextId) {
        const entry = await getEntry(this.deps.db, session.merchantId, nextId);
        return {
          state: "AWAITING_QR_MATCH",
          reply: lines.qrAsk(qr.amountRupees, entry.customer_name, toRupees(entry.pending_paise)),
          entry: toEntryDto(entry),
        };
      }
      const res = await this.deps.reconciler.dismissPayment(session.merchantId, qr.paymentId, "UNMATCHED");
      this.toIdle(session);
      return { state: "IDLE", reply: res.line };
    }
    return { state: "AWAITING_QR_MATCH", reply: lines.notUnderstoodYesNo() };
  }

  // ---------------------------------------------------------------- helpers

  private async extract(merchantId: string, text: string) {
    const customers = await listCustomers(this.deps.db, merchantId);
    return this.deps.extractor.extract(
      text,
      customers.map((c) => c.name),
    );
  }
}

function amountsOf(entry: EntryWithCustomer) {
  return {
    customerName: entry.customer_name,
    totalRupees: toRupees(entry.total_paise),
    paidRupees: toRupees(entry.paid_paise),
    pendingRupees: toRupees(entry.pending_paise),
  };
}
