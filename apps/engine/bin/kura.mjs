#!/usr/bin/env node
/**
 * KURA daemon launcher.
 *
 * The engine is TypeScript executed through tsx rather than a compiled bundle, so this
 * shim resolves tsx and hands it the entrypoint. A published build would point the bin
 * straight at compiled JS; nothing else about the command changes.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, '..');
const entry = resolve(engineRoot, 'src/index.ts');

const [command = 'start', ...rest] = process.argv.slice(2);

const USAGE = `kura — deterministic pre-trade gate for RYO-CHAN

  kura start        start the engine (HTTP API + SSE + MCP gateway on ENGINE_PORT)
  kura gateway      serve ONLY the MCP gateway over stdio, for command-based MCP
                    clients. stdout is JSON-RPC; diagnostics go to stderr.
  kura verify       verify the whole ledger hash chain
  kura --help

Configure the upstream peer in .env (RYO_MCP_URL / RYO_MCP_TOKEN). See README.md.
`;

if (command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(USAGE);
  process.exit(0);
}

function run(cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit', cwd: engineRoot });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    process.stderr.write(`kura: failed to launch ${cmd}: ${err.message}\n`);
    process.exit(1);
  });
}

if (command === 'gateway') {
  const stdioEntry = resolve(engineRoot, 'src/gateway/stdio.ts');
  if (!existsSync(stdioEntry)) {
    process.stderr.write(`kura: gateway entrypoint not found at ${stdioEntry}\n`);
    process.exit(1);
  }
  run('npx', ['tsx', stdioEntry, ...rest]);
} else if (command === 'start') {
  if (!existsSync(entry)) {
    process.stderr.write(`kura: entrypoint not found at ${entry}\n`);
    process.exit(1);
  }
  run('npx', ['tsx', entry, ...rest]);
} else if (command === 'verify') {
  const tool = resolve(engineRoot, '../../skills/verify_provenance/tool.py');
  run('python3', [tool, '--all', ...rest]);
} else {
  process.stderr.write(`kura: unknown command "${command}"\n\n${USAGE}`);
  process.exit(2);
}
