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
import nodemailer from 'nodemailer';
// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.get('/api/_debug/ethereal-test', async (req, res) => {
  try {
    console.time('ethereal-test');
    const account = await nodemailer.createTestAccount();
    console.log('Account created:', account.user);

    const transport = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
      connectionTimeout: 20000,
    });

    const info = await transport.sendMail({
      from: account.user,
      to: account.user,
      subject: 'test',
      text: 'hello',
    });

    console.timeEnd('ethereal-test');
    res.json({ ok: true, previewUrl: nodemailer.getTestMessageUrl(info) });
  } catch (error) {
    console.timeEnd('ethereal-test');
    console.error('Ethereal test failed:', error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

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
