import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import cors from 'cors';
import express from 'express';
import { registerAuthRoutes } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { registerEmailRoutes } from './emails.js';
import { emailQueue } from './queue.js';
import { ensureIndex } from './search.js';
import { registerSlackRoutes } from './slack.js';
import { requeueStuckDeliveries } from './worker.js';

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// Only allow requests from the configured web origin and local dev servers.
const permittedOrigins = new Set([
  config.webOrigin,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || permittedOrigins.has(origin));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: '25mb' }));

// ---------------------------------------------------------------------------
// Bull Board (queue monitoring UI)
// ---------------------------------------------------------------------------

const boardAdapter = new ExpressAdapter();
boardAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter: boardAdapter,
});

app.use('/admin/queues', boardAdapter.getRouter());

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

registerAuthRoutes(app);
registerEmailRoutes(app);
registerSlackRoutes(app);

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await db.query('select 1');
    res.json({ ok: true, workerConcurrency: config.concurrency });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const err = error as { name?: string; message?: string };
  const status = err?.name === 'ZodError' ? 400 : 500;
  res.status(status).json({ error: err?.message ?? 'Internal error' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await ensureIndex();
await requeueStuckDeliveries();

app.listen(config.port, () => {
  console.log(`API listening on :${config.port}`);
});
