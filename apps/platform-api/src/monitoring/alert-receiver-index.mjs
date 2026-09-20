import fs from 'node:fs/promises';
import { createAlertReceiver } from './alert-receiver.mjs';

async function start() {
  const secret = await fs.open(process.env.BAIRUI_ALERT_TOKEN_FILE ?? '/run/secrets/alert-token', 'r');
  let token;
  try {
    const stat = await secret.stat();
    if (!stat.isFile() || stat.size > 8192) throw new Error('invalid_alert_secret');
    token = (await secret.readFile('utf8')).trim();
  } finally { await secret.close(); }

  const portText = process.env.PORT ?? '9095';
  if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) > 65535) throw new Error('invalid_alert_port');
  const server = createAlertReceiver({ token, directory: process.env.BAIRUI_ALERT_DATA_DIR ?? '/data' });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(portText), '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      console.error('alert_receiver_shutdown_timeout');
      server.closeAllConnections();
      process.exit(1);
    }, 15000);
    deadline.unref();
    server.close(error => {
      clearTimeout(deadline);
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      if (error) process.exitCode = 1;
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  server.on('error', () => {
    console.error('alert_receiver_failed');
    process.exitCode = 1;
    stop();
  });
  console.log(JSON.stringify({ event: 'alert_receiver_listening', port: server.address().port }));
}

try { await start(); }
catch {
  console.error('alert_receiver_start_failed');
  process.exitCode = 1;
}
