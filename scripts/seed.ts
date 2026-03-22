/**
 * Seed script: creates a development user record and seeds model registry.
 * Run with: pnpm seed
 */
import { runMigrations, getDb, logger } from '@orchestrator/shared';
import { seedModelRegistry } from '@orchestrator/model-router';

async function seed() {
  // Initialize DB
  runMigrations();
  await seedModelRegistry();

  const db = getDb();

  // Create test user
  const userId = crypto.randomUUID();
  const userEmail = 'dev@orchestrator.local';

  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(userEmail) as { id: string } | undefined;

  let finalUserId: string = userId;

  if (existingUser) {
    logger.info('Test user already exists, updating...');
    finalUserId = existingUser.id;
    db.prepare('UPDATE users SET credits_balance = 100.0, tier = ? WHERE id = ?').run('pro', finalUserId);
  } else {
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      finalUserId,
      userEmail,
      'pro',
      100.0
    );
    logger.info({ userId: finalUserId, email: userEmail }, 'Test user created');
  }

  console.log('\n========================================');
  console.log('  Seed data created successfully!');
  console.log('========================================\n');
  console.log(`  User ID:    ${finalUserId}`);
  console.log(`  Email:      ${userEmail}`);
  console.log(`  Tier:       pro`);
  console.log(`  Credits:    100.00`);
  console.log('\n  Auth mode:  Clerk-only bearer tokens');
  console.log('  Seed no longer creates API keys.');
  console.log('\n  To call APIs, send a Clerk JWT in Authorization header:');
  console.log('  curl -H "Authorization: Bearer <clerk_jwt>" http://localhost:8080/v1/billing/balance');
  console.log('\n  Example Agent API call:');
  console.log(`  curl -X POST http://localhost:8080/v1/responses \\`);
  console.log('    -H "Authorization: Bearer <clerk_jwt>" \\');
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"model":"openai/gpt-4o","input":"Hello, world!"}'`);
  console.log('\n========================================\n');
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
