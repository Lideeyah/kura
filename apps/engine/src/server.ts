import Fastify from 'fastify';
import cors from '@fastify/cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { buildGatewayServer } from './gateway/mcp-server.js';
import { getQuota } from './mcp/client.js';
import { bus, type TelemetryEvent } from './bus/telemetry.js';
import { isToolName, TOOL_NAMES } from './schema/tools.js';
import type { Supervisor } from './supervisor.js';

export function buildServer(sup: Supervisor) {
  const app = Fastify({ logger: false });
  void app.register(cors, { origin: true });

  /**
   * KURA's own MCP endpoint — this is what an external agent registers as its gateway.
   *
   * Stateless mode: a fresh server and transport per request, so there is no session
   * affinity to lose and no cross-request state for a misbehaving client to poison.
   * Fastify has already parsed the JSON body, so it is handed straight to the
   * transport rather than being re-read off the socket.
   */
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      reply.hijack();
      const gateway = buildGatewayServer(sup);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      reply.raw.on('close', () => {
        void transport.close();
        void gateway.close();
      });
      try {
        await gateway.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
              id: null,
            }),
          );
        }
      }
    },
  });

  app.get('/api/health', async () => ({
    ok: true,
    connected: sup.connected,
    transport: sup.client.description,
    connect_error: sup.connectError,
    ledger_path: config.ledger.path,
    journal_mode: sup.ledger.journalMode,
    ledger_count: sup.ledger.count(),
    invariants: config.invariants,
    mcp_endpoint: `http://localhost:${config.port}/mcp`,
    evidence_probe: sup.evidenceProbe,
    quota: getQuota(),
  }));

  app.get('/api/tools', async () => ({
    tools: TOOL_NAMES,
    watchlist: sup.tokens,
    chaos: sup.chaos.snapshot(),
  }));

  /** SSE: replays the recent ring buffer, then streams live telemetry. */
  app.get('/api/stream', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: TelemetryEvent) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    send({
      type: 'hello',
      connected: sup.connected,
      ledgerCount: sup.ledger.count(),
      chaos: sup.chaos.snapshot(),
      at: new Date().toISOString(),
    });
    for (const past of bus.replay()) send(past);

    const unsubscribe = bus.subscribe(send);
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/ledger', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 500) || 500, 5000);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    return { count: sup.ledger.count(), records: sup.ledger.list(limit, offset) };
  });

  app.get<{ Params: { receiptId: string } }>('/api/ledger/:receiptId', async (req, reply) => {
    const record = sup.ledger.get(req.params.receiptId);
    if (!record) return reply.code(404).send({ error: 'RECEIPT_NOT_FOUND' });
    return record;
  });

  app.get('/api/chaos', async () => ({ chaos: sup.chaos.snapshot() }));


  app.post<{ Body: { tool?: string; action?: string; delayMs?: number } }>(
    '/api/chaos/toggle',
    async (req, reply) => {
      const { tool, action, delayMs } = req.body ?? {};
      if (typeof tool !== 'string' || (tool !== '*' && !isToolName(tool))) {
        return reply.code(400).send({ error: 'BAD_TOOL', allowed: ['*', ...TOOL_NAMES] });
      }
      const ALLOWED = ['DROP', 'DELAY', 'DEGRADE_STATUS', 'DEGRADE_MODE', 'RATE_LIMIT', 'RESET'];
      if (typeof action !== 'string' || !ALLOWED.includes(action)) {
        return reply.code(400).send({ error: 'BAD_ACTION', allowed: ALLOWED });
      }
      if (action === 'DELAY' && (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0)) {
        return reply.code(400).send({ error: 'BAD_DELAY_MS' });
      }
      sup.chaos.set(tool as '*', action as never, delayMs);
      return { ok: true, chaos: sup.chaos.snapshot() };
    },
  );

  app.post<{ Body: { receipt_id?: string; receiptId?: string } }>('/api/verify', async (req, reply) => {
    const receiptId = req.body?.receipt_id ?? req.body?.receiptId;
    if (typeof receiptId !== 'string' || !receiptId) {
      return reply.code(400).send({ error: 'MISSING_RECEIPT_ID' });
    }
    const result = sup.ledger.verify(receiptId);
    return reply.code(result.valid ? 200 : 409).send(result);
  });

  app.get('/api/verify/chain', async () => sup.ledger.verifyChain());

  /** Headline numbers for the Audit Ledger chain-health bar. */
  app.get('/api/ledger/stats', async () => {
    const rows = sup.ledger.list(100_000);
    const head = sup.ledger.head();
    return {
      total: rows.length,
      approved: rows.filter((r) => r.decision === 'APPROVED').length,
      vetoed: rows.filter((r) => r.decision === 'VETOED').length,
      headBlockHash: head?.block_hash ?? null,
      headSeq: head?.seq ?? 0,
      journalMode: sup.ledger.journalMode,
      ledgerPath: config.ledger.path,
    };
  });

  app.post<{ Body: { symbol?: string } }>('/api/evaluate', async (req, reply) => {
    const symbol = req.body?.symbol ?? sup.tokens[0]?.symbol;
    if (!symbol) return reply.code(400).send({ error: 'MISSING_SYMBOL' });
    const outcome = await sup.evaluate({ symbol });
    return { verdict: outcome.verdict, record: outcome.record };
  });

  /** The authenticated upstream catalog — the guide's final source of truth. */
  app.get('/api/catalog', async () => {
    const [catalog, health] = await Promise.all([sup.catalog(), sup.client.fetchHealth()]);
    return { catalog, health, expected: TOOL_NAMES };
  });

  return app;
}
