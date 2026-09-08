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
