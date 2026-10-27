import type { ErrorRequestHandler } from "express";
import { ZodError as ZodErrorV4 } from "zod/v4";
import { ZodError as ZodErrorV3 } from "zod/v3";

/**
 * Centralised error handler. Converts ZodError → 400 JSON ErrorResponse so
 * client param-validation failures don't surface as 500s. Anything else is
 * delegated to Express's default handler.
 *
 * NOTE: the codegen'd schemas in `@workspace/api-zod` import from `"zod"`
 * which resolves to the v3 surface in zod@3.x, while some hand-written
 * server code uses `"zod/v4"`. Both branches throw distinct ZodError
 * classes that fail a single `instanceof` check, so we accept either.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ZodErrorV4 || err instanceof ZodErrorV3) {
    req.log?.warn({ issues: err.issues }, "Bad request (zod)");
    const detail = err.issues
      .map((i) => `${(i.path ?? []).join(".")}: ${i.message}`)
      .join("; ");
    res.status(400).json({ error: `Invalid request: ${detail}` });
    return;
  }

  req.log?.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
};
