import { z } from "zod";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const stringWithDefault = (d: string) => z.preprocess(emptyToUndefined, z.string().default(d));

const EnvSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.enum(["development", "test", "production"]).default("development")),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(4000)),
  LOG_LEVEL: stringWithDefault("info"),

  PARI_API_KEY: z.preprocess(emptyToUndefined, z.string().min(8).default("pari-dev-key")),
  PARI_CORS_ORIGINS: stringWithDefault("http://localhost:5173,http://localhost:8081"),
  PARI_API_URL: stringWithDefault("http://localhost:4000"),
  PARI_PUBLIC_URL: optionalString,
  PARI_UPI_ID: z.preprocess(emptyToUndefined, z.string().regex(/^[\w.-]+@[a-zA-Z]+$/, "must look like name@bank").optional()),
  PARI_DEMO_SEED: z.preprocess(emptyToUndefined, z.stringbool().default(false)),

  DATABASE_URL: optionalString,
  PARI_PGLITE_DIR: stringWithDefault(".data/pglite"),

  SARVAM_API_KEY: optionalString,
  SARVAM_STT_MODEL: stringWithDefault("saaras:v4"),
  SARVAM_STT_MODE: stringWithDefault("codemix"),
  SARVAM_STT_LANGUAGE: stringWithDefault("hi-IN"),
  SARVAM_TTS_MODEL: stringWithDefault("bulbul:v4-flash"),
  PARI_TTS_SPEAKER: stringWithDefault("simran_enhi_customer"),
  PARI_TTS_PACE: z.coerce.number().min(0.5).max(2).default(1.15),
  SARVAM_CHAT_MODEL: stringWithDefault("sarvam-105b-conversations"),
  SARVAM_REASONING_EFFORT: z.preprocess(emptyToUndefined, z.enum(["none", "low", "high", "max"]).optional()),

  PARI_PAYTM_MODE: z.preprocess(emptyToUndefined, z.enum(["mock", "sandbox"]).default("mock")),
  PAYTM_MID: optionalString,
  PAYTM_MERCHANT_KEY: optionalString,
  PAYTM_HOST: stringWithDefault("https://securegw-stage.paytm.in"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.PARI_PAYTM_MODE === "sandbox" && (!env.PAYTM_MID || !env.PAYTM_MERCHANT_KEY)) {
    throw new Error("PARI_PAYTM_MODE=sandbox requires PAYTM_MID and PAYTM_MERCHANT_KEY");
  }
  return env;
}

export function corsOrigins(env: Env): string[] {
  return env.PARI_CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
}
