import { sql, type Kysely, type Transaction } from "kysely";
import { AppError, notFound } from "../helpers/errors.js";
import type { Actor, Customer, DB, EntryStatus, LedgerEntry, Payment, PaymentLink } from "../db/types.js";
import { isCloseName, normalizeName } from "./names.js";
import { assertTransition } from "./state.js";

export type Db = Kysely<DB>;

export interface EntryWithCustomer extends LedgerEntry {
  customer_name: string;
  customer_phone: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f-]{4,36}$/i;

export async function inTx<T>(db: Db, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  if (db.isTransaction) return fn(db as Transaction<DB>);
  return db.transaction().execute(fn);
}

export async function audit(
  db: Db,
  rec: {
    entryId?: string | null;
    paymentId?: string | null;
    from?: string | null;
    to?: string | null;
    actor: Actor;
    payload?: unknown;
  },
): Promise<void> {
  await db
    .insertInto("audit_log")
    .values({
      entry_id: rec.entryId ?? null,
      payment_id: rec.paymentId ?? null,
      from_status: rec.from ?? null,
      to_status: rec.to ?? null,
      actor: rec.actor,
      payload: rec.payload === undefined ? null : JSON.stringify(rec.payload),
    })
    .execute();
}

// ---------------------------------------------------------------- customers

export async function listCustomers(db: Db, merchantId: string): Promise<Customer[]> {
  return db.selectFrom("customers").selectAll().where("merchant_id", "=", merchantId).orderBy("name").execute();
}

export async function getCustomer(db: Db, merchantId: string, id: string): Promise<Customer> {
  if (!UUID_RE.test(id)) throw notFound("Customer");
  const customer = await db
    .selectFrom("customers")
    .selectAll()
    .where("merchant_id", "=", merchantId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!customer) throw notFound("Customer");
  return customer;
}

export async function findOrCreateCustomer(
  db: Db,
  merchantId: string,
  spokenName: string,
): Promise<{ customer: Customer; match: "exact" | "fuzzy" | "new" }> {
  const normalized = normalizeName(spokenName);
  if (!normalized) throw new AppError(422, "INVALID_CUSTOMER_NAME", "Customer name is empty");

  const all = await listCustomers(db, merchantId);
  const exact = all.find((c) => c.name_normalized === normalized);
  if (exact) return { customer: exact, match: "exact" };
  const fuzzy = all.find((c) => isCloseName(c.name_normalized, normalized));
  if (fuzzy) return { customer: fuzzy, match: "fuzzy" };

  const created = await db
    .insertInto("customers")
    .values({ merchant_id: merchantId, name: spokenName.trim(), name_normalized: normalized, phone: null })
    .onConflict((oc) => oc.columns(["merchant_id", "name_normalized"]).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (created) return { customer: created, match: "new" };
  const raced = await db
    .selectFrom("customers")
    .selectAll()
    .where("merchant_id", "=", merchantId)
    .where("name_normalized", "=", normalized)
    .executeTakeFirstOrThrow();
  return { customer: raced, match: "exact" };
}

export async function setCustomerPhone(db: Db, merchantId: string, customerId: string, phone: string): Promise<Customer> {
  if (!/^[6-9]\d{9}$/.test(phone)) throw new AppError(422, "INVALID_PHONE", "Phone must be a 10-digit Indian mobile number");
  const updated = await db
    .updateTable("customers")
    .set({ phone })
    .where("merchant_id", "=", merchantId)
    .where("id", "=", customerId)
    .returningAll()
    .executeTakeFirst();
  if (!updated) throw notFound("Customer");
  return updated;
}

export async function customerBalancePaise(db: Db, merchantId: string, customerId: string): Promise<number> {
  const row = await db
    .selectFrom("ledger_entries")
    .select(sql<number>`coalesce(sum(pending_paise), 0)::int`.as("pending"))
    .where("merchant_id", "=", merchantId)
    .where("customer_id", "=", customerId)
    .where("status", "=", "OPEN")
    .executeTakeFirstOrThrow();
  return Number(row.pending);
}

// ------------------------------------------------------------------ entries

function entryQuery(db: Db) {
  return db
    .selectFrom("ledger_entries as e")
    .innerJoin("customers as c", "c.id", "e.customer_id")
    .selectAll("e")
    .select(["c.name as customer_name", "c.phone as customer_phone"]);
}

export async function resolveEntryId(db: Db, merchantId: string, idOrPrefix: string): Promise<string> {
  if (UUID_RE.test(idOrPrefix)) return idOrPrefix.toLowerCase();
  if (!PREFIX_RE.test(idOrPrefix)) throw notFound("Entry");
  const rows = await db
    .selectFrom("ledger_entries")
    .select("id")
    .where("merchant_id", "=", merchantId)
    .where(sql`id::text`, "like", `${idOrPrefix.toLowerCase()}%`)
    .limit(2)
    .execute();
  if (rows.length === 0) throw notFound("Entry");
  if (rows.length > 1) throw new AppError(409, "AMBIGUOUS_ID", `More than one entry starts with "${idOrPrefix}"`);
  return rows[0]!.id;
}

export async function getEntry(db: Db, merchantId: string, idOrPrefix: string): Promise<EntryWithCustomer> {
  const id = await resolveEntryId(db, merchantId, idOrPrefix);
  const entry = await entryQuery(db).where("e.merchant_id", "=", merchantId).where("e.id", "=", id).executeTakeFirst();
  if (!entry) throw notFound("Entry");
  return entry;
}

export async function listEntries(
  db: Db,
  merchantId: string,
  filter: { status?: EntryStatus | undefined; customerId?: string | undefined; limit?: number | undefined } = {},
): Promise<EntryWithCustomer[]> {
  let q = entryQuery(db).where("e.merchant_id", "=", merchantId);
  if (filter.status) q = q.where("e.status", "=", filter.status);
  if (filter.customerId) q = q.where("e.customer_id", "=", filter.customerId);
  return q.orderBy("e.created_at", "desc").limit(filter.limit ?? 50).execute();
}

export interface EntryHistory {
  link: PaymentLink | null;
  payments: Payment[];
}

/** The latest payment link and the matched payments of each entry, in two queries. */
export async function entryHistory(db: Db, merchantId: string, entryIds: string[]): Promise<Map<string, EntryHistory>> {
  const history = new Map<string, EntryHistory>(entryIds.map((id) => [id, { link: null, payments: [] }]));
  if (entryIds.length === 0) return history;
  const [links, payments] = await Promise.all([
    db.selectFrom("payment_links").selectAll().where("entry_id", "in", entryIds).orderBy("created_at", "asc").execute(),
    db
      .selectFrom("payments")
      .selectAll()
      .where("merchant_id", "=", merchantId)
      .where("entry_id", "in", entryIds)
      .where("match_status", "=", "MATCHED")
      .orderBy("created_at", "asc")
      .execute(),
  ]);
  for (const link of links) history.get(link.entry_id)!.link = link;
  for (const payment of payments) history.get(payment.entry_id!)!.payments.push(payment);
  return history;
}

export interface Amounts {
  totalPaise: number;
  paidPaise: number;
  pendingPaise: number;
}

function assertAmounts(a: Amounts): void {
  const values = [a.totalPaise, a.paidPaise, a.pendingPaise];
  if (values.some((v) => !Number.isInteger(v) || v < 0)) {
    throw new AppError(422, "INVALID_AMOUNT", "Amounts must be non-negative whole paise");
  }
  if (a.totalPaise !== a.paidPaise + a.pendingPaise) {
    throw new AppError(422, "AMOUNT_MISMATCH", "total must equal paid + pending");
  }
}

export async function createUnconfirmedEntry(
  db: Db,
  input: Amounts & {
    merchantId: string;
    customerId: string;
    transcript: string | null;
    language: string | null;
    needsReview: boolean;
  },
): Promise<EntryWithCustomer> {
  assertAmounts(input);
  const id = await inTx(db, async (trx) => {
    const row = await trx
      .insertInto("ledger_entries")
      .values({
        merchant_id: input.merchantId,
        customer_id: input.customerId,
        total_paise: input.totalPaise,
        paid_paise: input.paidPaise,
        pending_paise: input.pendingPaise,
        transcript: input.transcript,
        language: input.language,
        needs_review: input.needsReview,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await audit(trx, { entryId: row.id, to: "UNCONFIRMED", actor: "system", payload: { transcript: input.transcript } });
    return row.id;
  });
  return getEntry(db, input.merchantId, id);
}

async function lockEntry(trx: Transaction<DB>, merchantId: string, id: string): Promise<LedgerEntry> {
  const entry = await trx
    .selectFrom("ledger_entries")
    .selectAll()
    .where("merchant_id", "=", merchantId)
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  if (!entry) throw notFound("Entry");
  return entry;
}

export async function updateUnconfirmedEntry(
  db: Db,
  merchantId: string,
  idOrPrefix: string,
  patch: Partial<Amounts> & { customerId?: string; needsReview?: boolean; transcript?: string },
): Promise<EntryWithCustomer> {
  const id = await resolveEntryId(db, merchantId, idOrPrefix);
  await inTx(db, async (trx) => {
    const entry = await lockEntry(trx, merchantId, id);
    if (entry.status !== "UNCONFIRMED") {
      throw new AppError(409, "ENTRY_LOCKED", "Only UNCONFIRMED entries can be edited");
    }
    const amounts = {
      totalPaise: patch.totalPaise ?? entry.total_paise,
      paidPaise: patch.paidPaise ?? entry.paid_paise,
      pendingPaise: patch.pendingPaise ?? entry.pending_paise,
    };
    assertAmounts(amounts);
    await trx
      .updateTable("ledger_entries")
      .set({
        total_paise: amounts.totalPaise,
        paid_paise: amounts.paidPaise,
        pending_paise: amounts.pendingPaise,
        ...(patch.customerId ? { customer_id: patch.customerId } : {}),
        ...(patch.needsReview !== undefined ? { needs_review: patch.needsReview } : {}),
        ...(patch.transcript !== undefined ? { transcript: patch.transcript } : {}),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .execute();
    await audit(trx, { entryId: id, from: "UNCONFIRMED", to: "UNCONFIRMED", actor: "merchant", payload: { edit: patch } });
  });
  return getEntry(db, merchantId, id);
}

/** Merchant said "haan". An entry with nothing pending closes straight away. */
export async function confirmEntry(db: Db, merchantId: string, idOrPrefix: string): Promise<EntryWithCustomer> {
  const id = await resolveEntryId(db, merchantId, idOrPrefix);
  await inTx(db, async (trx) => {
    const entry = await lockEntry(trx, merchantId, id);
    const to: EntryStatus = entry.pending_paise === 0 ? "CLOSED" : "OPEN";
    assertTransition(entry.status, to);
    await trx.updateTable("ledger_entries").set({ status: to, updated_at: new Date() }).where("id", "=", id).execute();
    await audit(trx, { entryId: id, from: entry.status, to, actor: "merchant" });
  });
  return getEntry(db, merchantId, id);
}

export async function rejectEntry(db: Db, merchantId: string, idOrPrefix: string): Promise<EntryWithCustomer> {
  const id = await resolveEntryId(db, merchantId, idOrPrefix);
  await inTx(db, async (trx) => {
    const entry = await lockEntry(trx, merchantId, id);
    assertTransition(entry.status, "REJECTED");
    await trx
      .updateTable("ledger_entries")
      .set({ status: "REJECTED", updated_at: new Date() })
      .where("id", "=", id)
      .execute();
    await audit(trx, { entryId: id, from: entry.status, to: "REJECTED", actor: "merchant" });
  });
  return getEntry(db, merchantId, id);
}

export interface AppliedPayment {
  appliedPaise: number;
  excessPaise: number;
  closed: boolean;
  pendingPaise: number;
}

/**
 * Applies up to the pending amount to an OPEN entry. Must run inside the
 * caller's transaction so the payment row and the balance change commit together.
 */
export async function applyPayment(
  trx: Transaction<DB>,
  merchantId: string,
  entryId: string,
  amountPaise: number,
  actor: Actor,
  payload: Record<string, unknown>,
): Promise<AppliedPayment> {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new AppError(422, "INVALID_AMOUNT", "Payment amount must be positive");
  }
  const entry = await lockEntry(trx, merchantId, entryId);
  if (entry.status !== "OPEN") {
    throw new AppError(409, "ENTRY_NOT_OPEN", `Entry is ${entry.status}, payments can only be applied to OPEN entries`);
  }
  const appliedPaise = Math.min(amountPaise, entry.pending_paise);
  const pendingPaise = entry.pending_paise - appliedPaise;
  const to: EntryStatus = pendingPaise === 0 ? "CLOSED" : "OPEN";
  await trx
    .updateTable("ledger_entries")
    .set({
      paid_paise: entry.paid_paise + appliedPaise,
      pending_paise: pendingPaise,
      status: to,
      updated_at: new Date(),
    })
    .where("id", "=", entryId)
    .execute();
  const excessPaise = amountPaise - appliedPaise;
  await audit(trx, {
    entryId,
    paymentId: typeof payload.paymentId === "string" ? payload.paymentId : null,
    from: "OPEN",
    to,
    actor,
    payload: { ...payload, appliedPaise, excessPaise },
  });
  return { appliedPaise, excessPaise, closed: to === "CLOSED", pendingPaise };
}
