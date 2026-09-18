/**
 * Outbound pacing and tool-level rate-limit recognition.
 *
 * Both exist because of what the live endpoint actually does: RYO signals rate limiting
 * as `isError: true` inside an HTTP 200, which the fetch-level 429 handler never sees.
 */
import { describe, expect, it } from 'vitest';
import { RatePacer } from '../src/mcp/pacer.js';
import { unwrapEnvelope } from '../src/mcp/interceptor.js';

const toolResult = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });

describe('tool-level rate limit recognition', () => {
  it('classifies RYO\'s own wording as a rate limit, not a generic tool error', () => {
    // This is verbatim what live RYO returned once the per-minute ceiling was reached.
    expect(() => unwrapEnvelope('analyze_token', toolResult('Rate limit'))).toThrow(
      /UPSTREAM_RATE_LIMITED/,
    );
  });

  it('recognises the common phrasings', () => {
    for (const text of ['rate limit exceeded', 'Too Many Requests', 'HTTP 429', 'quota exceeded']) {
      expect(() => unwrapEnvelope('analyze_token', toolResult(text))).toThrow(
        /UPSTREAM_RATE_LIMITED/,
      );
    }
  });

  it('still reports an unrelated tool failure as TOOL_ERROR', () => {
    expect(() => unwrapEnvelope('analyze_token', toolResult('unknown symbol XYZ'))).toThrow(
      /TOOL_ERROR/,
    );
  });
});

describe('outbound pacer', () => {
  /** `spacing` is passed explicitly so each test states which constraint it exercises. */
  const harness = (perMinute: number, spacing = 0) => {
    let now = 1_000_000;
    const slept: number[] = [];
    const pacer = new RatePacer(
      perMinute,
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      },
      spacing,
    );
    return { pacer, slept, advance: (ms: number) => (now += ms) };
  };

  it('is disabled when no ceiling is configured', async () => {
    const { pacer, slept } = harness(0);
    expect(pacer.enabled).toBe(false);
    for (let i = 0; i < 50; i += 1) await pacer.acquire();
    expect(slept).toHaveLength(0);
  });

  it('allows exactly the ceiling within a minute', async () => {
    const { pacer } = harness(60, 0);
    for (let i = 0; i < 60; i += 1) await pacer.acquire();
    expect(pacer.remaining()).toBe(0);
  });

  it('waits once the window is full, and only as long as needed', async () => {
    const { pacer, slept, advance } = harness(3, 0);
    await pacer.acquire();
    advance(10_000);
    await pacer.acquire();
    await pacer.acquire();
    expect(slept).toHaveLength(0);

    // Window full; the oldest call was 10s ago, so the next slot frees in 50s.
    await pacer.acquire();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeCloseTo(50_000, -2);
  });

  it('slides rather than resetting, so a burst cannot spend the whole minute at once', async () => {
    const { pacer, slept, advance } = harness(2, 0);
    await pacer.acquire();
    await pacer.acquire();
    advance(61_000); // both fall out of the window
    await pacer.acquire();
    await pacer.acquire();
    expect(slept).toHaveLength(0);
    expect(pacer.remaining()).toBe(0);
  });

  it('reports remaining capacity for the dashboard', async () => {
    const { pacer } = harness(10, 0);
    expect(pacer.remaining()).toBe(10);
    await pacer.acquire();
    await pacer.acquire();
    expect(pacer.remaining()).toBe(8);
  });
});

describe('burst spacing', () => {
  const harness = (perMinute: number) => {
    let now = 1_000_000;
    const slept: number[] = [];
    const pacer = new RatePacer(perMinute, () => now, async (ms) => {
      slept.push(ms);
      now += ms;
    });
    return { pacer, slept, advance: (ms: number) => (now += ms) };
  };

  it('spaces consecutive calls by 60000/perMinute', async () => {
    // The live constraint is burst rate, not volume: RYO refuses a rapid burst while
    // still reporting the full per-minute quota remaining.
    const { pacer, slept } = harness(60);
    await pacer.acquire();
    await pacer.acquire();
    await pacer.acquire();
    expect(slept).toEqual([1000, 1000]);
  });

  it('does not delay a call that is already late enough', async () => {
    const { pacer, slept, advance } = harness(60);
    await pacer.acquire();
    advance(1500);
    await pacer.acquire();
    expect(slept).toHaveLength(0);
  });

  it('honours an explicit override for a tighter or looser gap', async () => {
    let now = 0;
    const slept: number[] = [];
    const pacer = new RatePacer(60, () => now, async (ms) => { slept.push(ms); now += ms; }, 250);
    await pacer.acquire();
    await pacer.acquire();
    expect(slept).toEqual([250]);
  });
});

describe('pacing must not be measured as upstream latency', () => {
  it('is a distinct quantity from the round trip the FRESHNESS gate judges', async () => {
    // The gate asks how stale the upstream's answer is. A wait we imposed on ourselves
    // is not staleness — counting it turned a healthy ~900ms live call into 4287ms and
    // vetoed real market data.
    let now = 0;
    const pacer = new RatePacer(60, () => now, async (ms) => { now += ms; }, 3000);
    await pacer.acquire();
    const waited = await pacer.acquire();
    expect(waited).toBe(3000);
    // acquire() reports what it slept, so the caller can restart its clock afterwards.
    expect(typeof waited).toBe('number');
  });

  it('reports zero wait when no pacing was needed, so the clock is left alone', async () => {
    let now = 0;
    const pacer = new RatePacer(60, () => now, async (ms) => { now += ms; }, 0);
    expect(await pacer.acquire()).toBe(0);
    expect(await pacer.acquire()).toBe(0);
  });
});

/**
 * The two behaviours above interact, and the interaction is what broke.
 *
 * Pacing resets the latency clock, because a wait we impose on ourselves is not
 * upstream staleness. An injected DELAY is the opposite — it stands in for a slow
 * upstream — so it has to be measured. When the delay was applied *before* the pacer,
 * the reset erased it: with RYO_MIN_CALL_INTERVAL_MS set, as it is against live RYO,
 * the chaos lab's latency injection measured single-digit milliseconds and approved
 * rather than tripping FRESHNESS. Neither behaviour was wrong alone, which is why
 * nothing caught it.
 */
describe('injected latency survives pacing', () => {
  it('measures an injected delay even when the pacer also slept', async () => {
    const { InterceptedRyo, ChaosController } = await import('../src/mcp/interceptor.js');
    const chaos = new ChaosController();
    chaos.set('analyze_token', 'DELAY', 400);

    // rawCall returns an MCP tool result, so the envelope travels in structuredContent.
    const client = {
      rawCall: async () => ({
        structuredContent: {
          schema_version: '1.0.0', tool: 'analyze_token', status: 'ok', data_mode: 'live',
          as_of: new Date().toISOString(), request: { symbol: 'SOL' },
          data: { market: { price_usd: 172.44 }, technicals: { atr_14: 4.31 } },
          summary: { headline: 'SOL' }, availability: { market: 'ok' }, warnings: [],
        },
      }),
    } as never;

    // A pacer that genuinely sleeps on the first acquire. Without this the suite's
    // RYO_MIN_CALL_INTERVAL_MS=0 means no pacing happens, the clock is never reset,
    // and the test passes against the very ordering it exists to catch.
    // Pacing sleeps far longer than the injected delay, so the two outcomes are
    // separated by a full second rather than by a margin that ordinary scheduler
    // jitter can cross. Under load a tight window here flakes, and a flaky assertion
    // about ordering is worse than none.
    let paced = false;
    const pacer = {
      enabled: true,
      remaining: () => 60,
      acquire: async () => {
        if (paced) return 0;
        paced = true;
        await new Promise((r) => setTimeout(r, 1_500));
        return 1_500;
      },
    } as never;

    const ryo = new InterceptedRyo(client, chaos, pacer);
    const res = await ryo.call('analyze_token', { symbol: 'SOL' });

    expect(paced).toBe(true);
    // Wrong order erases the delay entirely and lands near 0; counting pacing would
    // land near 1900. Correct is ~400 plus whatever the fake call costs.
    expect(res.latencyMs).toBeGreaterThanOrEqual(390);
    expect(res.latencyMs).toBeLessThan(1_200);
  });
});
