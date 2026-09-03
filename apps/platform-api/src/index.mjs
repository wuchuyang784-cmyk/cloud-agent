import { createApp } from './app.mjs';

const port = Number(process.env.PORT ?? 8080);
const app = createApp();

const shutdown = async () => {
  await app.platform.store.close?.();
  app.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(port, '0.0.0.0', () => {
  console.log('platform-api listening on :' + port);
});
