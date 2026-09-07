/**
 * KURA's MCP gateway over stdio.
 *
 * The HTTP gateway covers clients that take a URL. This covers the other half of the
 * MCP client population — the ones configured with a command, e.g.
 *
 *   { "mcpServers": { "kura": { "command": "npx", "args": ["kura", "gateway"] } } }
 *
 * stdout is the JSON-RPC channel and nothing else. Every diagnostic on this path goes
 * to stderr, or it would corrupt the protocol stream.
 *
 * The autonomous pulse and evaluation loops are deliberately NOT started here: a
 * client-launched gateway should append to the ledger only when its agent actually
 * asks for an evaluation, not on a background timer.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Supervisor } from '../supervisor.js';
import { transportSpecFromConfig } from '../mcp/client.js';
import { buildGatewayServer } from './mcp-server.js';

async function main() {
  let sup: Supervisor;
  try {
    sup = new Supervisor(transportSpecFromConfig());
  } catch (err) {
    process.stderr.write(`[kura] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
    return;
  }

  // A failed upstream connection is not fatal: the gateway still serves, and
  // evaluate_candidate vetoes on ORACLE rather than pretending the peer is healthy.
  const connected = await sup.reconnectNow();
  process.stderr.write(
    `[kura] gateway on stdio · upstream ${sup.client.description} connected=${connected}\n`,
  );

  const server = buildGatewayServer(sup);
  await server.connect(new StdioServerTransport());

  const shutdown = async () => {
    await server.close().catch(() => {});
    await sup.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[kura] gateway fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
