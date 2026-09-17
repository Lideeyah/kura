import { config } from './config.js';
import { Supervisor } from './supervisor.js';
import { buildServer } from './server.js';
import { transportSpecFromConfig } from './mcp/client.js';

async function main() {
  let sup: Supervisor;
  try {
    sup = new Supervisor(transportSpecFromConfig());
  } catch (err) {
    console.error(`\n[kura] ${err instanceof Error ? err.message : String(err)}`);
    console.error('[kura] Copy .env.example to .env and point it at the live RYO-CHAN endpoint.\n');
    process.exit(1);
    return;
  }

  const app = buildServer(sup);

  // Connect before the port opens. Listening first left a window where an evaluation
  // was accepted with no MCP session behind it, and came back VETOED on FRESHNESS
  // citing NOT_CONNECTED at rtt 0ms — the engine's own cold start misreported as
  // upstream staleness. Connection failures stay non-fatal: the supervisor retries
  // with backoff and the dashboard shows the disconnected state rather than the
  // process dying, so a boot with RYO-CHAN unreachable still serves.
  await sup.start();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[kura] engine listening on http://localhost:${config.port}`);
  console.log(`[kura] ledger  ${config.ledger.path} (journal_mode=${sup.ledger.journalMode})`);
  console.log(`[kura] mcp     ${sup.client.description} connected=${sup.connected}`);

  const shutdown = async () => {
    await app.close();
    await sup.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[kura] fatal', err);
  process.exit(1);
});
