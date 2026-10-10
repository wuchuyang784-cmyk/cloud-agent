// Shares the E2 ownership-checked disposable Docker/PG/TLS harness; no .env or preprod.
process.argv.push('--supervision');
await import('./test-orchestrator.mjs');
