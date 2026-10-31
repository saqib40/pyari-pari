import type { AddressInfo } from "node:net";
import { SarvamAIError } from "sarvamai";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { toMerchantDto } from "../src/contracts/mappers.js";
import { seedDemoHistory } from "../src/db/seed.js";
import { generateSignature } from "../src/paytm/checksum.js";
import { SandboxPaytmClient } from "../src/paytm/sandbox.client.js";
import { mapSarvamError } from "../src/sarvam/client.js";
import { SarvamChatModel } from "../src/llm/sarvam-chat.js";
import { API_KEY, createTestContext, entryJson, type TestContext } from "./helpers.js";

const DECK = "Gupta ji ne 350 ka samaan liya, 200 UPI diya, 150 baaki.";
const WAV = Buffer.alloc(4000, 1);

let t: TestContext;
const api = () => request(t.app);
const auth = { "x-api-key": API_KEY };

beforeAll(async () => {
  t = await createTestContext();
  t.chat.set(DECK, entryJson("Gupta ji", 350, 200, 150));
  t.chat.set("Verma ji 500 udhaar", entryJson("Verma ji", 500, null, null));
  t.chat.set("Ramesh bhai 300 baaki", entryJson("Ramesh bhai", null, null, 300));
  t.stt.transcripts["gupta.wav"] = DECK;
  t.stt.transcripts["haan.webm"] = "हाँ जी";
  t.stt.transcripts["hmm.wav"] = "kal dekhte hain";
});
afterAll(() => t.close());

async function confirmedEntry(text: string) {
  const created = await api().post("/api/voice/entry").set(auth).send({ text, speak: false }).expect(201);
  await api().post(`/api/entries/${created.body.entry.id}/confirm`).set(auth).send({ answer: "yes" }).expect(200);
  return created.body.entry.id as string;
}

describe("basics", () => {
  it("health reports db, paytm mode and sarvam status", async () => {
    const res = await api().get("/health").expect(200);
    expect(res.body).toMatchObject({ ok: true, db: "pglite", paytm: "mock" });
  });

  it("requires an API key, header or ?key=", async () => {
    const res = await api().get("/api/entries").expect(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    await api().get(`/api/entries?key=${API_KEY}`).expect(200);
  });

  it("returns errors in one shape", async () => {
    const res = await api().post("/api/entries/abc/confirm").set(auth).send({ answer: "maybe" }).expect(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("allows the dev frontend origins", async () => {
    for (const origin of ["http://localhost:5173", "http://localhost:8081"]) {
      const res = await api().options("/api/entries").set("Origin", origin).set("Access-Control-Request-Method", "GET");
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("describes the shop and what its QR carries", async () => {
    const res = await api().get("/api/me").set(auth).expect(200);
    expect(res.body).toMatchObject({ name: "Sharma General Store", upiId: null, qrPayload: "Sharma General Store" });

    const withUpi = toMerchantDto({ id: "m1", name: "Sharma General Store", api_key_hash: "", created_at: new Date() }, "sharma@paytm");
    expect(withUpi.qrPayload).toBe("upi://pay?pa=sharma@paytm&pn=Sharma%20General%20Store&cu=INR");
  });

  it("streams TTS audio and reports per-stage timings on converse", async () => {
    const audio = await api().get("/api/tts/stream").query({ text: "सेव हो गया।", key: API_KEY }).buffer(true).expect(200);
    expect(audio.headers["content-type"]).toContain("audio/wav");
    expect(audio.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(audio.body.toString()).toContain("RIFF-fake");
    await api().get("/api/tts/stream").set(auth).expect(400);

    const turn = await api().post("/api/converse").set(auth).send({ text: "aaj mausam kaisa hai", speak: true }).expect(200);
    expect(turn.body.timings).toMatchObject({ thinkMs: expect.any(Number), ttsMs: expect.any(Number) });
  });
});

describe("voice entry + confirm", () => {
  it("audio in: transcribes, extracts, stores UNCONFIRMED, returns read-back audio", async () => {
    const res = await api().post("/api/voice/entry").set(auth).attach("audio", WAV, "gupta.wav").expect(201);
    expect(res.body).toMatchObject({
      transcript: DECK,
      needsReview: false,
      entry: { status: "UNCONFIRMED", totalRupees: 350, paidRupees: 200, pendingRupees: 150, customer: { name: "Gupta ji" } },
      readback: { text: "Gupta ji, total ₹350, ₹200 mile, ₹150 baaki. Save karoon?" },
    });
    expect(typeof res.body.readbackAudio).toBe("string");
    expect(t.tts.spoken.at(-1)).toBe(res.body.readback.speech);
  });

  it("spoken 'haan' confirms the entry", async () => {
    const created = await api().post("/api/voice/entry").set(auth).send({ text: DECK, speak: false }).expect(201);
    const res = await api()
      .post(`/api/entries/${created.body.entry.shortId}/confirm`)
      .set(auth)
      .attach("audio", WAV, { filename: "haan.webm", contentType: "audio/webm;codecs=opus" })
      .expect(200);
    expect(res.body).toMatchObject({ answer: "yes", entry: { status: "OPEN" } });
  });

  it("an unclear spoken answer is a 422, not a guess", async () => {
    const created = await api().post("/api/voice/entry").set(auth).send({ text: DECK, speak: false }).expect(201);
    const res = await api().post(`/api/entries/${created.body.entry.id}/confirm`).set(auth).attach("audio", WAV, "hmm.wav").expect(422);
    expect(res.body.error.code).toBe("ANSWER_UNCLEAR");
  });

  it("PATCH corrects amounts while UNCONFIRMED and keeps the books balanced", async () => {
    const created = await api().post("/api/voice/entry").set(auth).send({ text: DECK, speak: false }).expect(201);
    const res = await api().patch(`/api/entries/${created.body.entry.id}`).set(auth).send({ totalRupees: 300 }).expect(200);
    expect(res.body.entry).toMatchObject({ totalRupees: 300, paidRupees: 200, pendingRupees: 100 });
  });

  it("rejects non-audio uploads", async () => {
    const res = await api().post("/api/voice/entry").set(auth).attach("audio", Buffer.from("x"), { filename: "a.txt", contentType: "text/plain" });
    expect(res.status).toBe(415);
  });
});

describe("sarvam error mapping", () => {
  it("maps 402 to a clear credits-exhausted error without retrying", () => {
    const err = mapSarvamError(new SarvamAIError({ statusCode: 402, message: "insufficient_quota_error" }), "chat");
    expect(err).toMatchObject({ status: 402, code: "SARVAM_CREDITS_EXHAUSTED" });
    expect(mapSarvamError(new SarvamAIError({ statusCode: 403 }), "chat").code).toBe("SARVAM_AUTH");
  });

  it("a missing key fails with SARVAM_NOT_CONFIGURED before any request", async () => {
    const chat = new SarvamChatModel(loadEnv({ NODE_ENV: "test" }));
    await expect(chat.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "SARVAM_NOT_CONFIGURED", status: 503 });
  });
});

describe("collect + paytm callback", () => {
  it("needs a phone the first time, then reuses it", async () => {
    const id = await confirmedEntry(DECK);
    const missing = await api().post(`/api/entries/${id}/collect`).set(auth).send({}).expect(422);
    expect(missing.body.error.code).toBe("PHONE_REQUIRED");

    const sent = await api().post(`/api/entries/${id}/collect`).set(auth).send({ phone: "98765 43210" }).expect(201);
    expect(sent.body.link).toMatchObject({ amountRupees: 150, phone: "9876543210", status: "ACTIVE" });
    expect(sent.body.entry.customer.phone).toBe("9876543210");
    expect(t.paytm.sent.at(-1)).toMatchObject({ amountPaise: 15000, customerPhone: "9876543210" });

    const id2 = await confirmedEntry(DECK);
    const again = await api().post(`/api/entries/${id2}/collect`).set(auth).send({}).expect(201);
    expect(again.body.link.phone).toBe("9876543210");
  });

  it("callback with TXN_SUCCESS closes the entry by order id, and is idempotent", async () => {
    const id = await confirmedEntry(DECK);
    const sent = await api().post(`/api/entries/${id}/collect`).set(auth).send({}).expect(201);
    const form = { ORDERID: sent.body.link.orderId, TXNID: "TXN-1", TXNAMOUNT: "150.00", STATUS: "TXN_SUCCESS" };

    const first = await api().post("/api/paytm/callback").type("form").send(form).expect(200);
    expect(first.body.outcome).toBe("applied");
    const entry = await api().get(`/api/entries/${id}`).set(auth).expect(200);
    expect(entry.body.entry).toMatchObject({ status: "CLOSED", pendingRupees: 0, paidRupees: 350 });

    const dup = await api().post("/api/paytm/callback").type("form").send(form).expect(200);
    expect(dup.body.outcome).toBe("duplicate");
  });

  it("lists each entry with its latest link and the payments matched to it", async () => {
    const paidId = await confirmedEntry(DECK);
    await api().post(`/api/entries/${paidId}/collect`).set(auth).send({ phone: "98765 43210" }).expect(201);
    await api().post("/api/dev/simulate/link-paid").set(auth).send({ entryId: paidId }).expect(200);
    const openId = await confirmedEntry(DECK);

    const { body } = await api().get("/api/entries").set(auth).expect(200);
    const paid = body.entries.find((e: { id: string }) => e.id === paidId);
    expect(paid).toMatchObject({
      status: "CLOSED",
      link: { status: "PAID", amountRupees: 150, createdAt: expect.any(String) },
      payments: [{ source: "LINK", amountRupees: 150, matchStatus: "MATCHED" }],
    });
    expect(body.entries.find((e: { id: string }) => e.id === openId)).toMatchObject({ status: "OPEN", link: null, payments: [] });

    const single = await api().get(`/api/entries/${paidId}`).set(auth).expect(200);
    expect(single.body.entry.payments).toHaveLength(1);
  });

  it("ignores failed transactions", async () => {
    const res = await api().post("/api/paytm/callback").type("form").send({ ORDERID: "X", TXNID: "T9", TXNAMOUNT: "1", STATUS: "TXN_FAILURE" });
    expect(res.body.outcome).toBe("ignored");
  });

  it("sandbox client verifies the Paytm checksum", async () => {
    const key = "abcdefgh12345678";
    const client = new SandboxPaytmClient(loadEnv({ NODE_ENV: "test", PARI_PAYTM_MODE: "sandbox", PAYTM_MID: "MID1", PAYTM_MERCHANT_KEY: key }));
    const fields = { MID: "MID1", ORDERID: "PARI1", TXNID: "T1", TXNAMOUNT: "150.00", STATUS: "TXN_SUCCESS" };
    const params = Object.keys(fields).sort().map((k) => fields[k as keyof typeof fields]).join("|");
    const CHECKSUMHASH = await generateSignature(params, key);
    expect(client.parseCallback({ ...fields, CHECKSUMHASH })).toMatchObject({ txnId: "T1", amountPaise: 15000 });
    expect(client.parseCallback({ ...fields, TXNAMOUNT: "1500.00", CHECKSUMHASH })).toBeNull();
    expect(client.parseCallback({ ...fields, CHECKSUMHASH: "garbage" })).toBeNull();
  });
});

describe("part payments and QR fallback", () => {
  it("a part payment lowers pending and keeps the entry OPEN", async () => {
    const id = await confirmedEntry(DECK);
    await api().post(`/api/entries/${id}/collect`).set(auth).send({}).expect(201);
    const res = await api().post("/api/dev/simulate/link-paid").set(auth).send({ entryId: id, amountRupees: 100 }).expect(200);
    expect(res.body.entry).toMatchObject({ status: "OPEN", pendingRupees: 50 });
  });

  it("an over-payment on a link waits for the merchant", async () => {
    const id = await confirmedEntry(DECK);
    await api().post(`/api/entries/${id}/collect`).set(auth).send({}).expect(201);
    const res = await api().post("/api/dev/simulate/link-paid").set(auth).send({ entryId: id, amountRupees: 200 }).expect(200);
    expect(res.body.outcome.status).toBe("suggested");
    expect(res.body.entry.status).toBe("OPEN");
  });

  it("QR payment becomes a ranked suggestion; matching closes the entry", async () => {
    const id = await confirmedEntry("Ramesh bhai 300 baaki");
    const qr = await api().post("/api/dev/simulate/qr").set(auth).send({ amountRupees: 300, payerName: "Ramesh Kumar" }).expect(201);
    const top = qr.body.suggestion.candidates[0];
    expect(top.entry.id).toBe(id);
    expect(top.reason).toContain("exact pending amount");

    const list = await api().get("/api/payments/suggestions").set(auth).expect(200);
    expect(list.body.suggestions.map((s: { payment: { id: string } }) => s.payment.id)).toContain(qr.body.suggestion.payment.id);

    const matched = await api().post(`/api/payments/${qr.body.suggestion.payment.id}/match`).set(auth).send({ entryId: id }).expect(200);
    expect(matched.body).toMatchObject({ payment: { matchStatus: "MATCHED" }, entry: { status: "CLOSED" } });

    await api().post(`/api/payments/${qr.body.suggestion.payment.id}/match`).set(auth).send({ entryId: id }).expect(409);
  });

  it("QR with no plausible entry is UNMATCHED, never auto-matched", async () => {
    const res = await api().post("/api/dev/simulate/qr").set(auth).send({ amountRupees: 99999 }).expect(201);
    expect(res.body.suggestion).toMatchObject({ candidates: [], payment: { matchStatus: "UNMATCHED" } });
  });
});

describe("demo history seed", () => {
  it("gives a fresh merchant a few past entries, once", async () => {
    const fresh = await createTestContext();
    try {
      expect(await seedDemoHistory(fresh.ctx.db, fresh.merchantId)).toBe(true);
      expect(await seedDemoHistory(fresh.ctx.db, fresh.merchantId)).toBe(false);

      const { body } = await request(fresh.app).get("/api/entries").set(auth).expect(200);
      const byName = Object.fromEntries(body.entries.map((e: { customer: { name: string } }) => [e.customer.name, e]));
      expect(body.entries).toHaveLength(4);
      expect(byName["Ramesh bhai"]).toMatchObject({ status: "OPEN", pendingRupees: 400, link: null });
      expect(byName["Sunita didi"]).toMatchObject({ status: "OPEN", pendingRupees: 1200, link: { status: "ACTIVE", amountRupees: 1200 } });
      expect(byName["Anil bhai"]).toMatchObject({ status: "CLOSED", payments: [{ source: "LINK", amountRupees: 650 }] });
      expect(byName["Kavita ji"]).toMatchObject({ status: "CLOSED", payments: [{ source: "QR", amountRupees: 420 }] });
      expect(Date.parse(byName["Ramesh bhai"].createdAt)).toBeLessThan(Date.now() - 23 * 3_600_000);
    } finally {
      await fresh.close();
    }
  });
});

describe("SSE events", () => {
  it("streams payment events to the merchant", async () => {
    const server = t.app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      const id = await confirmedEntry("Verma ji 500 udhaar");
      await api().post(`/api/entries/${id}/collect`).set(auth).send({ phone: "9123456780" }).expect(201);

      const res = await fetch(`http://127.0.0.1:${port}/api/events?key=${API_KEY}`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const waitFor = async (needle: string) => {
        while (!buffer.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value);
        }
      };
      await waitFor("pari.ready");
      await api().post("/api/dev/simulate/link-paid").set(auth).send({ entryId: id }).expect(200);
      await waitFor("event: pari.payment.received");
      expect(buffer).toContain("Verma ji ne ₹500 de diye. Khaata band.");
    } finally {
      controller.abort();
      server.close();
    }
  });
});
