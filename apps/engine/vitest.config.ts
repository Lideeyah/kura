import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The end-to-end suite spawns a real MCP peer over stdio and drives real timeouts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The ledger is a single SQLite file with a strict hash chain; parallel files
    // would interleave appends and make sequence assertions meaningless.
    fileParallelism: false,
    /**
     * Pin every knob the assertions depend on.
     *
     * `config.ts` loads the repo's `.env`, and dotenv does not override variables that
     * are already set — so declaring them here makes the suite hermetic. Without this,
     * tuning `.env` for the live endpoint (a 2500ms latency ceiling, outbound pacing)
     * silently broke ten assertions that are pinned to the documented defaults. Test
     * outcomes must not depend on how one developer's machine happens to be configured.
     */
    env: {
      INV_MAX_LATENCY_MS: '1200',
      INV_MAX_AS_OF_AGE_MS: '300000',
      KELLY_BANKROLL_USD: '100000',
      KELLY_FRACTION: '0.25',
      KELLY_PAYOFF_RATIO: '1.5',
      KELLY_P_MAX: '0.55',
      KELLY_MAX_POSITION_PCT: '0.05',
      KELLY_MAX_ATR_PCT: '0.15',
      KELLY_HYPER_VOL_ATR_PCT: '0.5',
      // No outbound pacing in tests: it would add real wall-clock sleeps for nothing.
      RYO_RATE_PER_MINUTE: '0',
      RYO_MIN_CALL_INTERVAL_MS: '0',
      RYO_RETRY_MAX_ATTEMPTS: '4',
      RYO_RETRY_BASE_DELAY_MS: '500',
      AUTO_EVALUATE: '0',
      PULSE_SWEEP_TOOLS: '0',
      EVIDENCE_PROBE: '0',
      KURA_WATCHLIST: 'SOL,AVAX',
    },
  },
});
