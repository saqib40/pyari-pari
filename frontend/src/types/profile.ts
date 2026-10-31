export type Profile = {
  id: string;
  /** Shop name customers see under the QR code. */
  businessName: string;
  /** The shop's UPI ID, shown under the QR code. Not set for a demo shop. */
  paymentAddress: string | null;
  /** Exact string encoded into the QR code. */
  qrPayload: string;
};
