import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { WebhookHandlers } from "./webhookHandlers";
import { logger } from "./lib/logger";
import { errorHandler } from "./middlewares/errorHandler";
import { bootstrapAdminPassword } from "./lib/adminBootstrap";

// Fire-and-forget at module load. Logs (warn/error) cover any failure path.
void bootstrapAdminPassword().catch((err) => {
  logger.error({ err }, "admin-bootstrap: unexpected failure");
});

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        // Strip query strings, then redact the iCal feed token in the path.
        // The token IS the auth — leaking it via stdout/log aggregation would
        // let anyone subscribe to the SP's bookings.
        let url = req.url?.split("?")[0];
        if (url) {
          url = url.replace(/\/api\/ical\/sp\/[^/.]+\.ics/, "/api/ical/sp/[REDACTED].ics");
        }
        return {
          id: req.id,
          method: req.method,
          url,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Register Stripe webhook BEFORE express.json() — needs raw Buffer body
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      res.status(400).json({ error: 'Missing stripe-signature' });
      return;
    }

    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;

      if (!Buffer.isBuffer(req.body)) {
        console.error('STRIPE WEBHOOK ERROR: req.body is not a Buffer');
        res.status(500).json({ error: 'Webhook processing error' });
        return;
      }

      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Webhook error:', message);
      res.status(400).json({ error: 'Webhook processing error' });
    }
  }
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

app.use(errorHandler);

export default app;
