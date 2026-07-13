import { seedDefaultProviders } from '../src/agent/seed-providers';

async function main() {
  const seeded = await seedDefaultProviders();
  console.log(
    seeded
      ? 'Finished seeding default providers.'
      : 'Providers already exist, skipping seed.',
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
