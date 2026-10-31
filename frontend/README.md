# Pyari Pari — frontend

Expo (SDK 58) app for a voice-first khata, running on the Pari backend in [`../backend`](../backend). The merchant speaks an entry, confirms it, and collects what is still owed; payments close entries by themselves.

- **Listen**: tap the sky orb and speak, e.g. "Gupta ji ne 350 ka samaan liya, 200 UPI diya, 150 baaki". Pari reads it back ("Gupta ji, total ₹350, ₹200 mile, ₹150 baaki. Save karoon?") and nothing is saved until the merchant says or taps yes. If money is still owed, Pari offers to text a Paytm payment link, asking for the customer's number the first time only.
- **QR**: the shop's payment code. When money lands on it without a link, Pari asks "₹150 aaya, Gupta ji ka?" aloud, and a card steps through the likeliest open entries.
- **Ledger**: what is left to collect, what came in today, and every entry with its baaki, grouped by day.

The backend runs the conversation. The app sends what the merchant said to `POST /api/converse`, as a recording or as the "haan" or "nahi" of a button, then shows Pari's reply and plays it from `/api/tts/stream`. Payments, and Pari's questions about them, arrive as server-sent events from `/api/events`.

## Run it

Start the backend first; it needs a `SARVAM_API_KEY` (see [`../backend/README.md`](../backend/README.md)):

```bash
cd backend && npm install && cp .env.example .env   # set SARVAM_API_KEY
npm run dev                                          # API on :4000
```

Then the app in a browser:

```bash
cd frontend
npm install                  # also copies Skia's canvaskit.wasm into public/ for web
cp .env.example .env.local   # explains each setting
npx expo start --web
```

The browser asks for the microphone the first time you tap the sky. Before calling a change done, run `npx tsc --noEmit` and `npx expo lint`.

## On an Android phone

Recording needs native modules, so use a development build rather than Expo Go. With the phone on USB debugging:

```bash
adb reverse tcp:4000 tcp:4000         # the phone's localhost:4000 is the laptop's backend
adb reverse tcp:8081 tcp:8081         # Metro, for a debug build
npx expo run:android                  # or --variant release, which needs no Metro
```

## Demo tools

With `EXPO_PUBLIC_DEMO_TOOLS=true` and the backend in `PARI_PAYTM_MODE=mock`, two long-presses stand in for a customer paying, like the CLI's L and Q keys:

- Long-press a ledger row marked "Link sent": the link gets paid, the entry closes, and Pari announces it.
- Long-press the shop QR code: a QR payment arrives for what the newest open entry still owes, and Pari asks whose it is.

The demo script is in the [root README](../README.md#10-mobile-app--demo).

## Layout

```
src/
  app/            routes only (Expo Router): root stack and the (tabs) navigator
  features/       one folder per screen: screen UI, its hooks and components
  components/     shared UI (sky orb, tab bar, text, buttons, segmented control)
  services/       the only code that talks to the backend: REST, events, recording upload, speech
  theme/          colors, typography, spacing, motion
  types/          backend responses (rupees, in api.ts) and the app's own types (paise)
```

Screens read data through React Query hooks (`features/*/use-*.ts`), and those hooks call `services/*`, which turn the backend's rupees and statuses into the app's types. The Listen tab keeps Pari's latest turn in `features/listening/conversation-store.ts`, so events and the QR tab can update it too.
