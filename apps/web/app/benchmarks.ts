import report from '../../../bench-resilience.json';

/**
 * Committed measurements from `npm run test:resilience` — 50 real trials per fault
 * class against a live MCP peer. Imported rather than transcribed, so the panel can
 * never drift from the numbers the benchmark actually produced.
 */
export interface FaultReport {
  fault: string;
  trials: number;
  detectionRate: number;
  recoveryRate: number;
  medianMs: number;
  p95Ms: number;
}

export const RESILIENCE = report as unknown as {
  generatedAt: string;
  trialsPerClass: number;
  reports: FaultReport[];
  chain: { valid: boolean; length: number };
};

export const FAULT_LABEL: Record<string, string> = {
  latency_spike: 'Latency spike',
  malformed_payload: 'Malformed payload',
  peer_crash: 'Peer crash',
};
