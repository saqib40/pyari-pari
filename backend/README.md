# Pari backend

Pari is a voice-first udhar (credit) ledger for Paytm merchants. The merchant says "Gupta ji ne 350 ka samaan liya, 200 UPI diya, 150 baaki". Pari reads the entry back and, once confirmed, sends a Paytm link for the pending ₹150. The entry closes when the link is paid. If the money arrives on the shop QR instead, Pari asks "₹150 aaya, Gupta ji ka?".

The Express API is the product. The hands-free terminal (`npm run pari`) is a thin client over it, and a web or mobile frontend can use the same endpoints later.

> For full system architecture, financial state diagrams, reconciliation algorithms, and design rationale, refer to the [Main Architecture README](../README.md).

## Stack

Node 22, TypeScript, Express 5, Zod, Kysely on Postgres (PGlite is used when `DATABASE_URL` is empty). Sarvam AI provides speech-to-text (`saaras:v4`), text-to-speech (`bulbul:v4-flash`) and the LLM (`sarvam-105b-conversations`). Paytm is either a built-in mock or the Payment Links sandbox.

## Setup

```bash
cd backend
npm install
cp .env.example .env      # then put your key in SARVAM_API_KEY=
npm run sarvam:hello      # one chat call to check the key
sudo apt install sox libsox-fmt-pulse
```

You don't need Docker. With `DATABASE_URL` empty, the server keeps its data in `.data/pglite` and migrates and seeds itself on start. To use real Postgres instead, run `docker compose up -d` and set `DATABASE_URL=postgres://pari:pari@localhost:5432/pari`.

## Run it

```bash
npm run pari
```

This starts the server in the background (logs go to `.data/server.log`), measures the room noise for a second, then listens. There is no wake word: whatever you say goes to Pari. Speech that isn't a ledger entry is shown as ignored and not answered. The terminal shows a live status line (listening, hearing you, thinking, speaking), each transcript, Pari's reply, the entry card, and the timing of every turn. Ctrl+C stops both the app and the server. `npm run pari -- --mute` turns Pari's voice off.

Pari's reply is printed as soon as it is ready, and her voice streams from Bulbul so it starts about half a second later. The speaking pace is `PARI_TTS_PACE` (default 1.15, range 0.5 to 2).

Keys while Pari is listening:

| Key | What it does |
| --- | --- |
| Space | Push-to-talk: speak, press Space again to send (Esc cancels). Use it when the room is noisy |
| E | Show the latest entries |
| L | Pretend the customer paid the newest open entry's Paytm link |
| Q | Pretend the newest open entry's pending amount arrived on the shop QR |

## Demo script

1. Say *"Gupta ji ne 350 ka samaan liya, 200 UPI diya, 150 baaki."*
2. Pari answers *"Gupta ji, total ₹350, ₹200 mile, ₹150 baaki. Save karoon?"* Say **"haan"**, or **"nahi, 250 diye"** to correct it.
3. Pari asks *"₹150 ka payment link bhejun?"* Say **"haan"**, then the number: *"98765 43210"*. Pari reads it back. Say **"haan"** and the link is sent.
4. Press **L**. Pari announces *"Gupta ji ne ₹150 de diye. Khaata band."*
5. Make a second entry and answer **"nahi"** when Pari offers a link. Press **Q**. Pari asks *"₹150 aaya, Gupta ji ka?"*. Say **"haan"** and the entry closes.
6. Press **E** to see everything.

Also try: a number that isn't a mobile number ("ek do teen") and Pari asks again; a fully paid entry ("poora de diya") closes at once with no link.

## API for a frontend

Every `/api` route except the Paytm callback needs `x-api-key: <PARI_API_KEY>`. For `EventSource` and `<audio src>` you can pass `?key=` instead. Amounts are in rupees. Errors look like `{ "error": { "code", "message", "details" } }`. The request and response types are in `src/contracts/index.ts`, so a frontend can import them.

| Method and path | Purpose |
| --- | --- |
| `POST /api/converse` | One conversational turn: JSON `{ text }`, or multipart `audio` plus optional `speak=false`. Returns the reply line, the base64 WAV (unless `speak=false`), the state, the entry and link if there are any, and per-stage `timings` |
| `GET /api/converse/state`, `POST /api/converse/reset` | Inspect or reset the session |
| `GET /api/events` | SSE: `pari.ready`, `pari.entry.updated`, `pari.payment.received`, `pari.payment.suggested`, `pari.prompt`, `pari.announce` |
| `POST /api/voice/entry` | Stateless: audio or text in, an `UNCONFIRMED` entry and read-back out |
| `GET /api/me` | The shop for this API key: `{ id, name, upiId, qrPayload }`. `qrPayload` is a UPI payment intent when `PARI_UPI_ID` is set |
| `GET /api/entries`, `GET` or `PATCH /api/entries/:id` | List, read, or correct an entry. Reads include the latest payment `link` and the matched `payments` |
| `POST /api/entries/:id/confirm` | `{ answer: "yes" \| "no" }`, or a spoken answer as audio |
| `POST /api/entries/:id/collect` | `{ phone? }`. Sends the payment link |
| `GET /api/customers`, `GET /api/customers/:id/balance` | Customers and what they owe |
| `GET /api/payments/suggestions`, `POST /api/payments/:id/match` | Pending QR matches. Body is `{ entryId }` or `{ reject: true }`. Settling a payment here also drops Pari's spoken question about it |
| `POST /api/stt`, `POST /api/tts` | Raw Saaras and Bulbul |
| `GET /api/tts/stream?text=` | Bulbul WAV streamed as it is generated (first audio in ~0.5 s) |
| `POST /api/paytm/callback` | Paytm status callback (checksum verified, no API key) |
| `POST /api/dev/simulate/link-paid`, `POST /api/dev/simulate/qr` | Mock mode only |
| `GET /health` | Status of the database, Paytm mode and Sarvam key |

A browser can record with `MediaRecorder` (webm/opus) and post the blob to `/api/converse` with `speak=false`, show `reply.text` at once, and play `/api/tts/stream?text=<reply.speech>&key=...` in an `<audio>` element. Listen on `/api/events?key=...` for Pari's QR questions and payment announcements.

## Sarvam credits

A full Gupta ji conversation by voice costs roughly ₹0.5 to ₹1. Speech-to-text costs ₹0.49 a minute, text-to-speech ₹1 per 1,000 characters, and the LLM a few paise per turn. Silence costs nothing: only sound above the measured room noise is sent. In a room with constant talking, every clip goes to speech-to-text, so use Space (push-to-talk) there. Repeated lines are cached and spoken for free. When credits run out, the API returns `402 SARVAM_CREDITS_EXHAUSTED`.

## Real Paytm sandbox (optional)

Set `PARI_PAYTM_MODE=sandbox`, `PAYTM_MID` and `PAYTM_MERCHANT_KEY` (16 characters). Then run `ngrok http 4000` and set `PARI_PUBLIC_URL=https://<ngrok-host>`. Links are created with `statusCallbackUrl=<PARI_PUBLIC_URL>/api/paytm/callback`, and paying one with Paytm's test credentials closes the entry. The callback field names are matched loosely (ORDERID, LINKID, MERC_UNQ_REF), because this path hasn't been tested against live Paytm yet.

## Tests

`npm test` runs about 90 tests with no network: number parsing, extraction checks, entry states, the reconciler, the conversation engine, the HTTP API and an end-to-end run through the terminal's API client against a live server. The LLM, speech and Paytm are all faked. `npm run typecheck` and `npm run build` should both be clean.

## Layout

```
src/
  server.ts, app.ts, context.ts   boot, Express app, dependency wiring
  config/       env validation
  contracts/    request schemas and response types shared with frontends
  db/           Kysely client, PGlite dialect, migrations, seed
  ledger/       repository, state machine, reconciler, link collection
  conversation/ per-merchant voice session state machine
  llm/          extraction, Hindi number parsing, read-back lines
  stt/ tts/ sarvam/  Sarvam Saaras, Bulbul and client
  paytm/        mock and sandbox clients, checksum
  events/       in-process event bus behind SSE
  routes/       HTTP routes
  cli/          the hands-free terminal
tests/
```
