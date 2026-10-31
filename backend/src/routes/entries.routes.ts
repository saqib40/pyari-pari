import { Router } from "express";
import { CollectBody, ConfirmBody, ListEntriesQuery, PatchEntryBody, type BalanceResponse } from "../contracts/index.js";
import { toCustomerDto, toEntryDto, toLedgerEntryDto } from "../contracts/mappers.js";
import type { AppContext } from "../context.js";
import { merchantId } from "../helpers/auth.js";
import { AppError } from "../helpers/errors.js";
import { audioFromRequest, audioUpload } from "../helpers/upload.js";
import { detectYesNo } from "../llm/intent.js";
import {
  confirmEntry,
  customerBalancePaise,
  entryHistory,
  findOrCreateCustomer,
  getCustomer,
  getEntry,
  listCustomers,
  listEntries,
  rejectEntry,
  updateUnconfirmedEntry,
} from "../ledger/repository.js";
import { toPaise, toRupees } from "../ledger/state.js";

export function entriesRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/entries", async (req, res) => {
    const mid = merchantId(req);
    const q = ListEntriesQuery.parse(req.query);
    const entries = await listEntries(ctx.db, mid, q);
    const history = await entryHistory(ctx.db, mid, entries.map((e) => e.id));
    res.json({ entries: entries.map((e) => toLedgerEntryDto(e, history.get(e.id)!)) });
  });

  router.get("/entries/:id", async (req, res) => {
    const mid = merchantId(req);
    const entry = await getEntry(ctx.db, mid, req.params.id);
    const history = await entryHistory(ctx.db, mid, [entry.id]);
    res.json({ entry: toLedgerEntryDto(entry, history.get(entry.id)!) });
  });

  router.patch("/entries/:id", async (req, res) => {
    const mid = merchantId(req);
    const body = PatchEntryBody.parse(req.body);
    const current = await getEntry(ctx.db, mid, req.params.id);
    const customerId = body.customerName ? (await findOrCreateCustomer(ctx.db, mid, body.customerName)).customer.id : undefined;

    // Recompute whichever amount was not given so the books still balance.
    let total = body.totalRupees !== undefined ? toPaise(body.totalRupees) : current.total_paise;
    let paid = body.paidRupees !== undefined ? toPaise(body.paidRupees) : current.paid_paise;
    let pending = body.pendingRupees !== undefined ? toPaise(body.pendingRupees) : current.pending_paise;
    if (body.pendingRupees === undefined) pending = total - paid;
    else if (body.paidRupees === undefined) paid = total - pending;
    else if (body.totalRupees === undefined) total = paid + pending;

    const entry = await updateUnconfirmedEntry(ctx.db, mid, current.id, {
      totalPaise: total,
      paidPaise: paid,
      pendingPaise: pending,
      needsReview: false,
      ...(customerId ? { customerId } : {}),
    });
    res.json({ entry: toEntryDto(entry) });
  });

  /** `{ answer: "yes" | "no" }`, or a spoken "haan"/"nahi" as multipart `audio`. */
  router.post("/entries/:id/confirm", audioUpload, async (req, res) => {
    const mid = merchantId(req);
    const id = String(req.params.id);
    const audio = audioFromRequest(req);
    let answer: "yes" | "no";
    let transcript: string | undefined;
    if (audio) {
      transcript = (await ctx.stt.transcribe(audio)).transcript;
      const detected = detectYesNo(transcript);
      if (detected === "unknown") {
        throw new AppError(422, "ANSWER_UNCLEAR", `Could not tell yes or no from "${transcript}"`);
      }
      answer = detected;
    } else {
      answer = ConfirmBody.parse(req.body).answer;
    }
    const entry = answer === "yes" ? await confirmEntry(ctx.db, mid, id) : await rejectEntry(ctx.db, mid, id);
    const dto = toEntryDto(entry);
    ctx.events.publish(mid, { type: "entry.updated", entry: dto });
    res.json({ entry: dto, answer, ...(transcript !== undefined ? { transcript } : {}) });
  });

  router.post("/entries/:id/collect", async (req, res) => {
    const body = CollectBody.parse(req.body ?? {});
    const result = await ctx.collect.sendLink(merchantId(req), req.params.id, body.phone);
    res.status(201).json(result);
  });

  router.get("/customers", async (req, res) => {
    const customers = await listCustomers(ctx.db, merchantId(req));
    res.json({ customers: customers.map(toCustomerDto) });
  });

  router.get("/customers/:id/balance", async (req, res) => {
    const mid = merchantId(req);
    const customer = await getCustomer(ctx.db, mid, req.params.id);
    const [pendingPaise, open] = await Promise.all([
      customerBalancePaise(ctx.db, mid, customer.id),
      listEntries(ctx.db, mid, { status: "OPEN", customerId: customer.id }),
    ]);
    const body: BalanceResponse = {
      customer: toCustomerDto(customer),
      pendingRupees: toRupees(pendingPaise),
      openEntries: open.map(toEntryDto),
    };
    res.json(body);
  });

  return router;
}
