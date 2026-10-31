import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ConverseResponse, PariEventDto } from "../src/contracts/index.js";
import { API_KEY, createTestContext, entryJson, type TestContext } from "./helpers.js";

const DECK = "Gupta ji ne 350 ka samaan liya, 200 UPI diya, 150 baaki.";
const WAV = Buffer.alloc(4000, 1);

let t: TestContext;
const contexts: TestContext[] = [];
const auth = { "x-api-key": API_KEY };

beforeEach(async () => {
  t = await createTestContext();
  contexts.push(t);
  t.chat.set(DECK, entryJson("Gupta ji", 350, 200, 150));
  t.chat.set("nahi, Gupta ji ka 300 ka saamaan tha, 200 diye", entryJson("Gupta ji", 300, 200, null));
  t.chat.set("Verma ji ko 150 udhaar", entryJson("Verma ji", 150, null, null));
  t.chat.set("Sunita didi 150 baaki", entryJson("Sunita didi", null, null, 150));
});
afterAll(async () => {
  for (const c of contexts) await c.close();
});

async function say(text: string, speak = false): Promise<ConverseResponse> {
  const res = await request(t.app).post("/api/converse").set(auth).send({ text, speak });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ConverseResponse;
}

describe("Pari conversation (deck flow)", () => {
  it("speak -> confirm -> link -> phone -> link paid closes by order id", async () => {
    const events: PariEventDto[] = [];
    t.ctx.events.subscribe(t.merchantId, (e) => events.push(e));

    let turn = await say(DECK, true);
    expect(turn.state).toBe("AWAITING_ENTRY_CONFIRM");
    expect(turn.reply.text).toBe("Gupta ji, total ₹350, ₹200 mile, ₹150 baaki. Save karoon?");
    expect(turn.entry).toMatchObject({ status: "UNCONFIRMED", pendingRupees: 150 });
    expect(turn.replyAudio).toBeTruthy();

    turn = await say("Haan");
    expect(turn.state).toBe("AWAITING_COLLECT_CHOICE");
    expect(turn.reply.text).toBe("Save ho gaya. ₹150 ka payment link bhejun?");
    expect(turn.entry!.status).toBe("OPEN");

    turn = await say("haan bhej do");
    expect(turn.state).toBe("AWAITING_PHONE");
    expect(turn.reply.text).toBe("Gupta ji ka mobile number bataiye.");

    turn = await say("nau aath saat chhe paanch chaar teen do ek zero");
    expect(turn.state).toBe("AWAITING_PHONE_CONFIRM");
    expect(turn.reply.text).toBe("98765 43210. Sahi hai?");
    expect(turn.reply.speech).toContain("9 8 7 6 5, 4 3 2 1 0");

    turn = await say("haan sahi hai");
    expect(turn.state).toBe("IDLE");
    expect(turn.reply.text).toBe("Link bhej diya. Gupta ji ko ₹150 ka link SMS ho gaya.");
    expect(turn.link).toMatchObject({ amountRupees: 150, phone: "9876543210" });
    expect(t.paytm.sent).toHaveLength(1);

    await request(t.app)
      .post("/api/paytm/callback")
      .type("form")
      .send({ ORDERID: turn.link!.orderId, TXNID: "T-100", TXNAMOUNT: "150.00", STATUS: "TXN_SUCCESS" })
      .expect(200);
    const entry = await request(t.app).get(`/api/entries/${turn.entry!.id}`).set(auth).expect(200);
    expect(entry.body.entry).toMatchObject({ status: "CLOSED", pendingRupees: 0 });
    const announced = events.find((e) => e.type === "payment.received");
    expect(announced && "line" in announced && announced.line.text).toBe("Gupta ji ne ₹150 de diye. Khaata band.");
  });

  it("phone number is asked only once per customer", async () => {
    await say(DECK);
    await say("haan");
    await say("haan");
    await say("9876543210");
    await say("haan");

    await say(DECK);
    await say("haan");
    const turn = await say("haan");
    expect(turn.state).toBe("IDLE");
    expect(turn.reply.text).toContain("Link bhej diya");
  });

  it("'nahi' with a correction re-reads the amounts before saving", async () => {
    await say(DECK);
    const turn = await say("nahi, Gupta ji ka 300 ka saamaan tha, 200 diye");
    expect(turn.state).toBe("AWAITING_ENTRY_CONFIRM");
    expect(turn.reply.text).toBe("Theek kiya. Gupta ji, total ₹300, ₹200 mile, ₹100 baaki. Save karoon?");
    expect(turn.entry).toMatchObject({ status: "UNCONFIRMED", totalRupees: 300, pendingRupees: 100 });
  });

  it("plain 'nahi' cancels; nothing is saved without a yes", async () => {
    const first = await say(DECK);
    const turn = await say("nahi");
    expect(turn).toMatchObject({ state: "IDLE", reply: { text: "Theek hai, entry cancel. Dobara boliye." } });
    const entry = await request(t.app).get(`/api/entries/${first.entry!.id}`).set(auth).expect(200);
    expect(entry.body.entry.status).toBe("REJECTED");
  });

  it("asks again when the answer is unclear, without changing anything", async () => {
    await say(DECK);
    const turn = await say("kal dekhte hain");
    expect(turn.state).toBe("AWAITING_ENTRY_CONFIRM");
    expect(turn.reply.text).toContain("Haan ya nahi boliye");
  });

  it("rejects a number that is not an Indian mobile", async () => {
    await say("Verma ji ko 150 udhaar");
    await say("haan");
    await say("haan");
    const turn = await say("12345 67890");
    expect(turn).toMatchObject({ state: "AWAITING_PHONE", reply: { text: expect.stringContaining("10 digit") } });
  });

  it("declining the link leaves the entry open", async () => {
    await say(DECK);
    await say("haan");
    const turn = await say("nahi, abhi nahi");
    expect(turn).toMatchObject({ state: "IDLE", reply: { text: "Theek hai, link nahi bheja. Entry khuli hai." } });
  });

  it("small talk gets a hint, not an entry", async () => {
    const turn = await say("aaj bahut garmi hai");
    expect(turn.state).toBe("IDLE");
    expect(turn.reply.text).toContain("Aise boliye");
  });

  it("QR paid instead: Pari asks '₹150 aaya, Gupta ji ka?' and the merchant confirms", async () => {
    const prompts: PariEventDto[] = [];
    t.ctx.events.subscribe(t.merchantId, (e) => e.type === "pari.prompt" && prompts.push(e));

    await say(DECK);
    await say("haan");
    await say("nahi");

    await request(t.app).post("/api/dev/simulate/qr").set(auth).send({ amountRupees: 150 }).expect(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ state: "AWAITING_QR_MATCH", line: { text: "₹150 aaya, Gupta ji ka?" } });

    const turn = await say("haan");
    expect(turn).toMatchObject({
      state: "IDLE",
      reply: { text: "Theek hai, Gupta ji ke khaate mein jod diya. Khaata band." },
      entry: { status: "CLOSED" },
    });
  });

  it("a QR question settled by tap is not asked again by voice", async () => {
    await say(DECK);
    await say("haan");
    await say("nahi");
    const qr = await request(t.app).post("/api/dev/simulate/qr").set(auth).send({ amountRupees: 150 }).expect(201);
    await new Promise((r) => setTimeout(r, 50));
    const state = () => request(t.app).get("/api/converse/state").set(auth).expect(200);
    expect((await state()).body.state).toBe("AWAITING_QR_MATCH");

    const { payment, candidates } = qr.body.suggestion;
    await request(t.app).post(`/api/payments/${payment.id}/match`).set(auth).send({ entryId: candidates[0].entry.id }).expect(200);
    expect((await state()).body.state).toBe("IDLE");

    const turn = await say("haan");
    expect(turn.state).toBe("IDLE");
    expect(turn.reply.text).toContain("Aise boliye");
  });

  it("a tap on a different payment leaves the spoken question in place", async () => {
    await say(DECK);
    await say("haan");
    await say("nahi");
    const asked = await request(t.app).post("/api/dev/simulate/qr").set(auth).send({ amountRupees: 150 }).expect(201);
    await new Promise((r) => setTimeout(r, 50));
    const other = await request(t.app).post("/api/dev/simulate/qr").set(auth).send({ amountRupees: 100 }).expect(201);
    expect(other.body.suggestion.payment.id).not.toBe(asked.body.suggestion.payment.id);

    await request(t.app).post(`/api/payments/${other.body.suggestion.payment.id}/match`).set(auth).send({ reject: true }).expect(200);
    const turn = await say("haan");
    expect(turn).toMatchObject({ state: "IDLE", entry: { status: "CLOSED" } });
  });

  it("QR that arrives mid-conversation is asked right after the current flow ends", async () => {
    await say("Sunita didi 150 baaki");
    await say("haan");
    await say("nahi");
    await say(DECK);
    await request(t.app).post("/api/dev/simulate/qr").set(auth).send({ amountRupees: 150, payerName: "Gupta" }).expect(201);

    const stillCollecting = await say("haan");
    expect(stillCollecting.state).toBe("AWAITING_COLLECT_CHOICE");

    const turn = await say("nahi");
    expect(turn.state).toBe("AWAITING_QR_MATCH");
    expect(turn.reply.text).toBe("Theek hai, link nahi bheja. Entry khuli hai. ₹150 aaya, Gupta ji ka?");
  });

  it("'nahi' moves to the next candidate, then keeps the payment aside", async () => {
    await say("Sunita didi 150 baaki");
    await say("haan");
    await say("nahi");
    await say(DECK);
    await say("haan");
    await say("nahi");

    await request(t.app).post("/api/dev/simulate/qr").set(auth).send({ amountRupees: 150 }).expect(201);
    await new Promise((r) => setTimeout(r, 50));
    let turn = await say("nahi");
    expect(turn.state).toBe("AWAITING_QR_MATCH");
    expect(turn.reply.text).toMatch(/₹150 aaya, (Gupta ji|Sunita didi) ka\?/);
    turn = await say("nahi");
    expect(turn).toMatchObject({ state: "IDLE", reply: { text: "Theek hai, yeh payment alag rakh diya." } });

    const s = await request(t.app).get("/api/payments/suggestions").set(auth).expect(200);
    expect(s.body.suggestions).toHaveLength(0);
  });

  it("accepts audio turns and returns the transcript", async () => {
    t.stt.transcripts["entry.webm"] = DECK;
    const res = await request(t.app)
      .post("/api/converse")
      .set(auth)
      .field("speak", "false")
      .attach("audio", WAV, { filename: "entry.webm", contentType: "audio/webm" })
      .expect(200);
    expect(res.body).toMatchObject({ transcript: DECK, state: "AWAITING_ENTRY_CONFIRM" });
    expect(res.body.replyAudio).toBeUndefined();
  });

  it("reset drops back to IDLE", async () => {
    await say(DECK);
    await request(t.app).post("/api/converse/reset").set(auth).expect(200);
    const state = await request(t.app).get("/api/converse/state").set(auth).expect(200);
    expect(state.body.state).toBe("IDLE");
  });
});
