import { readConfig } from './config.mjs';
import { createPiRuntimeService } from './service.mjs';

let service;
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config' || !args[1].startsWith('/run/config/') || args[1].includes('..')) throw new Error('invalid_arguments');
  service = await createPiRuntimeService({ config: await readConfig(args[1]) });
  await service.start();
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await service.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch {
  if (service) await service.close();
  process.stderr.write('pi_runtime_startup_failed\n');
  process.exitCode = 1;
}
