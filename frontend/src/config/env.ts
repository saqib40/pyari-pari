export const env = {
  /** The Pari backend. On an Android phone, `adb reverse tcp:4000 tcp:4000` makes localhost reach the laptop. */
  apiUrl: (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/+$/, ''),
  /** Picks the merchant; the backend seeds one for its PARI_API_KEY. */
  apiKey: process.env.EXPO_PUBLIC_API_KEY || 'pari-dev-key',
  /** Long-press shortcuts that pretend a customer paid. The backend only allows them in mock Paytm mode. */
  demoTools: process.env.EXPO_PUBLIC_DEMO_TOOLS === 'true',
} as const;
