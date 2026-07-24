import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseDatabaseUrl(url: string): {
  user: string;
  password: string;
  host: string;
  port: string;
} {
  const urlObj = new URL(url);
  return {
    user: urlObj.username,
    password: urlObj.password,
    host: urlObj.hostname,
    port: urlObj.port,
  };
}

function buildTestDbUrl(url: string, testDbName: string): string {
  const parsed = parseDatabaseUrl(url);
  return `postgresql://${parsed.user}:${parsed.password}@${parsed.host}:${parsed.port}/${testDbName}`;
}

// Runs exactly once, in Vitest's main process, before any api/*.test.ts
// file's own worker starts. Each test file gets its own module instance, so
// test-setup.ts's setupTestDatabase() (memoized per-module) can't actually
// share a single "has this been done yet" flag across files — every file
// was independently racing to create+migrate the same test_db_test
// database, and whichever file lost the race ran its tests against tables
// that didn't exist yet (P2021 errors). `prisma migrate deploy` creates its
// target database automatically if missing, then applies every migration —
// doing that exactly once here, before any file starts, makes every file's
// own (now redundant, but harmless and idempotent) setupTestDatabase() call
// a fast no-op instead of a race participant.
export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test_db';
  const testDbName = process.env.TEST_DATABASE_NAME || 'test_db_test';
  const testDbUrl = buildTestDbUrl(databaseUrl, testDbName);
  const serverDir = join(__dirname, '..', 'server');

  await execAsync('npx prisma migrate deploy', {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: testDbUrl },
  });
}
