import { createApp } from './app';
import { env } from './config/env';
import { initFirebase } from './config/firebase';

async function main() {
  initFirebase();
  const app = createApp();
  app.listen(env.port, env.host, () => {
    console.log(`Viseth API listening on ${env.host}:${env.port}`);
    console.log(`Public base: ${env.baseUrl}`);
    console.log(
      `Payments: ${env.isMockPayments ? 'MOCK' : 'TELEBIRR'} (${env.telebirrMode})`,
    );
  });
}

main().catch((err) => {
  console.error('Failed to start Viseth API', err);
  process.exit(1);
});
