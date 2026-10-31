import type { Request, RequestHandler } from "express";
import type { Merchant } from "../db/types.js";
import { hashApiKey } from "../db/seed.js";
import type { Db } from "../ledger/repository.js";
import { AppError } from "./errors.js";

declare global {
  namespace Express {
    interface Request {
      merchant?: Merchant;
    }
  }
}

/**
 * `x-api-key` header, or `?key=` for clients that cannot set headers
 * (the browser's EventSource for /api/events).
 */
export function requireMerchant(db: Db): RequestHandler {
  const cache = new Map<string, Merchant>();
  return async (req, _res, next) => {
    const header = req.header("x-api-key");
    const query = typeof req.query.key === "string" ? req.query.key : undefined;
    const key = header ?? query;
    if (!key) throw new AppError(401, "UNAUTHORIZED", "Missing x-api-key header");
    const hash = hashApiKey(key);
    let merchant = cache.get(hash);
    if (!merchant) {
      merchant = await db.selectFrom("merchants").selectAll().where("api_key_hash", "=", hash).executeTakeFirst();
      if (!merchant) throw new AppError(401, "UNAUTHORIZED", "Unknown API key");
      cache.set(hash, merchant);
    }
    req.merchant = merchant;
    next();
  };
}

export function currentMerchant(req: Request): Merchant {
  if (!req.merchant) throw new AppError(401, "UNAUTHORIZED", "Not authenticated");
  return req.merchant;
}

export function merchantId(req: Request): string {
  return currentMerchant(req).id;
}
