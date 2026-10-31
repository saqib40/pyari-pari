import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sql, type Kysely } from "kysely";
import { normalizeName } from "../ledger/names.js";
import type { DB, Merchant, PaymentSource } from "./types.js";

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

const DEMO_CUSTOMERS = ["Gupta ji", "Verma ji", "Ramesh bhai", "Sunita didi"];

/** Idempotent: makes sure the merchant for this API key exists. */
export async function ensureMerchant(db: Kysely<DB>, apiKey: string, name = "Sharma General Store"): Promise<Merchant> {
  const hash = hashApiKey(apiKey);
  const existing = await db.selectFrom("merchants").selectAll().where("api_key_hash", "=", hash).executeTakeFirst();
  if (existing) return existing;
  return db.insertInto("merchants").values({ name, api_key_hash: hash }).returningAll().executeTakeFirstOrThrow();
}

export async function seedDemo(db: Kysely<DB>, apiKey: string): Promise<Merchant> {
  const merchant = await ensureMerchant(db, apiKey);
  for (const name of DEMO_CUSTOMERS) {
    await db
      .insertInto("customers")
      .values({ merchant_id: merchant.id, name, name_normalized: normalizeName(name), phone: null })
      .onConflict((oc) => oc.columns(["merchant_id", "name_normalized"]).doNothing())
      .execute();
  }
  return merchant;
}

interface PastEntry {
  customer: string;
  phone?: string;
  totalRupees: number;
  paidRupees: number;
  /** Postgres interval, e.g. "1 day 2 hours". */
  ago: string;
  /** A link for the pending amount was sent and is still unpaid. */
  linkSent?: boolean;
  /** The pending amount arrived later and closed the entry. */
  settled?: { by: PaymentSource; ago: string };
}

const PAST_ENTRIES: PastEntry[] = [
  { customer: "Ramesh bhai", totalRupees: 900, paidRupees: 500, ago: "1 day" },
  { customer: "Sunita didi", phone: "9812345670", totalRupees: 1800, paidRupees: 600, ago: "2 days 2 hours", linkSent: true },
  { customer: "Anil bhai", phone: "9988776655", totalRupees: 650, paidRupees: 0, ago: "2 days 6 hours", settled: { by: "LINK", ago: "2 days 1 hour" } },
  { customer: "Kavita ji", totalRupees: 420, paidRupees: 0, ago: "3 days 4 hours", settled: { by: "QR", ago: "3 days 2 hours" } },
];

/** A few days of earlier khaata so a fresh demo ledger is not empty. Only seeds a merchant with no entries. */
export async function seedDemoHistory(db: Kysely<DB>, merchantId: string): Promise<boolean> {
  const any = await db.selectFrom("ledger_entries").select("id").where("merchant_id", "=", merchantId).executeTakeFirst();
  if (any) return false;
  await db.transaction().execute(async (trx) => {
    for (const past of PAST_ENTRIES) {
      const customer = await trx
        .insertInto("customers")
        .values({ merchant_id: merchantId, name: past.customer, name_normalized: normalizeName(past.customer), phone: past.phone ?? null })
        .onConflict((oc) => oc.columns(["merchant_id", "name_normalized"]).doUpdateSet({ phone: past.phone ?? null }))
        .returning("id")
        .executeTakeFirstOrThrow();

      const totalPaise = past.totalRupees * 100;
      const upfrontPaise = past.paidRupees * 100;
      const owedPaise = totalPaise - upfrontPaise;
      const transcript = `${past.customer} ne ${past.totalRupees} ka samaan liya${past.paidRupees ? `, ${past.paidRupees} diye` : ""}`;
      const { rows } = await sql<{ id: string }>`
        insert into ledger_entries (merchant_id, customer_id, total_paise, paid_paise, pending_paise, status, transcript, created_at, updated_at)
        values (${merchantId}, ${customer.id}, ${totalPaise}, ${past.settled ? totalPaise : upfrontPaise}, ${past.settled ? 0 : owedPaise},
                ${past.settled ? "CLOSED" : "OPEN"}, ${transcript}, now() - ${past.ago}::interval, now() - ${past.settled?.ago ?? past.ago}::interval)
        returning id`.execute(trx);
      const entryId = rows[0]!.id;

      let orderId: string | null = null;
      if (past.linkSent || past.settled?.by === "LINK") {
        orderId = `PARI${entryId.slice(0, 8).toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`;
        await sql`
          insert into payment_links (entry_id, order_id, amount_paise, status, short_url, phone, created_at)
          values (${entryId}, ${orderId}, ${owedPaise}, ${past.settled ? "PAID" : "ACTIVE"}, ${`https://paytm.me/mock-${orderId.slice(-6)}`},
                  ${past.phone ?? null}, now() - ${past.ago}::interval + interval '5 minutes')`.execute(trx);
      }
      if (past.settled) {
        await sql`
          insert into payments (merchant_id, source, txn_id, order_id, amount_paise, entry_id, match_status, created_at, resolved_at)
          values (${merchantId}, ${past.settled.by}, ${`SEED${randomBytes(6).toString("hex")}`}, ${orderId}, ${owedPaise}, ${entryId}, 'MATCHED',
                  now() - ${past.settled.ago}::interval, now() - ${past.settled.ago}::interval)`.execute(trx);
      }
    }
  });
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { loadEnv } = await import("../config/env.js");
  const { openDatabase } = await import("./client.js");
  const { migrate } = await import("./migrate.js");
  const env = loadEnv();
  const database = await openDatabase({ url: env.DATABASE_URL, pgliteDir: env.PARI_PGLITE_DIR });
  await migrate(database);
  const merchant = await seedDemo(database.db, env.PARI_API_KEY);
  console.log(`Seeded merchant "${merchant.name}" with customers: ${DEMO_CUSTOMERS.join(", ")}`);
  if (env.PARI_DEMO_SEED && (await seedDemoHistory(database.db, merchant.id))) console.log("Seeded a few days of past entries");
  await database.close();
}
