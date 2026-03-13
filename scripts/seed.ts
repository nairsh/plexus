/**
 * Seed script: creates a test user and API key for development.
 * Run with: pnpm seed
 */
import { createHash } from 'node:crypto';
import { runMigrations, getDb, logger } from '@orchestrator/shared';
import { seedModelRegistry } from '@orchestrator/model-router';

function seed() {
  // Initialize DB
  runMigrations();
  seedModelRegistry();

  const db = getDb();

  // Create test user
  const userId = crypto.randomUUID();
  const userEmail = 'dev@orchestrator.local';

  const existingUser = db
    .prepare('SELECT id FROM users WHERE email = ?')
    .get(userEmail) as { id: string } | undefined;

  let finalUserId: string = userId;

  if (existingUser) {
    logger.info('Test user already exists, updating...');
    finalUserId = existingUser.id;
    db.prepare('UPDATE users SET credits_balance = 100.0, tier = ? WHERE id = ?').run(
      'pro',
      finalUserId
    );
  } else {
    db.prepare(
      'INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)'
    ).run(finalUserId, userEmail, 'pro', 100.0);
    logger.info({ userId: finalUserId, email: userEmail }, 'Test user created');
  }

  // Create API key
  const rawKey = `sk-dev-${crypto.randomUUID().replace(/-/g, '')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.substring(0, 12);
  const keyId = crypto.randomUUID();

  // Remove old dev keys
  db.prepare(
    "DELETE FROM api_keys WHERE user_id = ? AND name = 'Development Key'"
  ).run(finalUserId);

  db.prepare(
    'INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, permissions) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(keyId, finalUserId, keyHash, keyPrefix, 'Development Key', '["all"]');

  console.log('\n========================================');
  console.log('  Seed data created successfully!');
  console.log('========================================\n');
  console.log(`  User ID:    ${finalUserId}`);
  console.log(`  Email:      ${userEmail}`);
  console.log(`  Tier:       pro`);
  console.log(`  Credits:    100.00`);
  console.log(`  API Key:    ${rawKey}`);
  console.log(`  Key Prefix: ${keyPrefix}`);
  console.log('\n  Use this API key in requests:');
  console.log(`  curl -H "Authorization: Bearer ${rawKey}" http://localhost:3000/v1/billing/balance`);
  console.log('\n  Example Agent API call:');
  console.log(`  curl -X POST http://localhost:3000/v1/responses \\`);
  console.log(`    -H "Authorization: Bearer ${rawKey}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"model":"openai/gpt-4o","input":"Hello, world!"}'`);
  console.log('\n========================================\n');
}

seed();
