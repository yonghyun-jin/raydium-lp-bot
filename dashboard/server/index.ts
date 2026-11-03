/**
 * The read-only dashboard.
 *
 * It queries Postgres and renders. It never calls the Orchestrator, never
 * touches the chain, and has no write path of any kind -- every operation,
 * swap and automation control stays in Telegram as a slash command. That is a
 * settled decision, not an unfinished one.
 *
 * It also runs as its OWN Railway service. Keeping it out of the bot's
 * container is what lets the bot stay a portless long-polling worker, so
 * railway.toml's "it never binds a port" and the guard in
 * tests/no-v0-resurrection.test.ts both stay true as written.
 */

import express from 'express';
import * as path from 'path';
import { basicAuth, readCredentials } from './auth';
import { loadReport, prisma } from './pnl';
import { loadEpisodes } from './predictions';

const PORT = Number(process.env.PORT) || 3000;

async function main(): Promise<void> {
  const credentials = readCredentials(process.env);
  if ('error' in credentials) {
    console.error(`[dashboard] refusing to start: ${credentials.error}`);
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('[dashboard] refusing to start: DATABASE_URL is not set.');
    process.exit(1);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(basicAuth(credentials));

  app.get('/api/pnl', async (_req, res) => {
    try {
      res.json(await loadReport());
    } catch (error) {
      // A read that fails is reported as a failure. There is no cached or
      // partial answer here -- a dashboard that quietly serves stale numbers
      // is worse than one that says it is broken.
      console.error('[dashboard] /api/pnl failed', error);
      res.status(503).json({
        error: 'Could not read the ledger.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get('/api/predictions', async (_req, res) => {
    try {
      res.json(await loadEpisodes());
    } catch (error) {
      // The price path comes from outside this service, so this endpoint has a
      // failure mode /api/pnl does not. It says so rather than rendering a
      // chart with no line in it, which reads as "the price sat still".
      console.error('[dashboard] /api/predictions failed', error);
      res.status(503).json({
        error: 'Could not read the predictions.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const web = path.join(__dirname, '..', 'web', 'dist');
  app.use(express.static(web));
  app.get('*', (_req, res) => res.sendFile(path.join(web, 'index.html')));

  const server = app.listen(PORT, () => {
    console.log(`[dashboard] listening on :${PORT}`);
  });

  const shutdown = async () => {
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('[dashboard] failed to start', error);
  process.exit(1);
});
