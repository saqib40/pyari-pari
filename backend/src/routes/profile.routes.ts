import { Router } from "express";
import { toMerchantDto } from "../contracts/mappers.js";
import type { AppContext } from "../context.js";
import { currentMerchant } from "../helpers/auth.js";

export function profileRoutes(ctx: AppContext): Router {
  const router = Router();

  /** The shop the API key belongs to, and what its QR code carries. */
  router.get("/me", (req, res) => {
    res.json(toMerchantDto(currentMerchant(req), ctx.env.PARI_UPI_ID));
  });

  return router;
}
