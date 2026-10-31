import { Router } from "express";
import { MatchBody } from "../contracts/index.js";
import type { AppContext } from "../context.js";
import { merchantId } from "../helpers/auth.js";

export function paymentsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/payments/suggestions", async (req, res) => {
    res.json({ suggestions: await ctx.reconciler.getSuggestions(merchantId(req)) });
  });

  router.post("/payments/:id/match", async (req, res) => {
    const mid = merchantId(req);
    const body = MatchBody.parse(req.body);
    const result =
      "entryId" in body
        ? await ctx.reconciler.matchPayment(mid, req.params.id, body.entryId)
        : await ctx.reconciler.dismissPayment(mid, req.params.id, "REJECTED");
    await ctx.conversation.releasePayment(mid, result.payment.id);
    res.json(result);
  });

  return router;
}
