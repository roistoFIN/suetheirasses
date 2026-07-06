import { PrismaClient } from '@prisma/client';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let prisma: PrismaClient | null = null;
let testDbUrl: string | null = null;

export interface TestDbContext {
  prisma: PrismaClient;
  dbUrl: string;
  cleanup: () => Promise<void>;
}

function parseDatabaseUrl(url: string): {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
} {
  const urlObj = new URL(url);
  return {
    user: urlObj.username,
    password: urlObj.password,
    host: urlObj.hostname,
    port: parseInt(urlObj.port, 10),
    database: urlObj.pathname.slice(1),
  };
}

function buildAdminUrl(url: string): string {
  const parsed = parseDatabaseUrl(url);
  return `postgresql://${parsed.user}:${parsed.password}@${parsed.host}:${parsed.port}/postgres`;
}

function buildTestDbUrl(url: string, testDbName: string): string {
  const parsed = parseDatabaseUrl(url);
  return `postgresql://${parsed.user}:${parsed.password}@${parsed.host}:${parsed.port}/${testDbName}`;
}

export async function setupTestDatabase(): Promise<TestDbContext> {
  if (prisma && testDbUrl) {
    return { prisma, dbUrl: testDbUrl, cleanup: teardownTestDatabase };
  }

  // Use DATABASE_URL from environment (set by CI or .env)
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test_db';
  const testDbName = process.env.TEST_DATABASE_NAME || 'test_db_test';

  // Create test database if it doesn't exist
  const adminUrl = buildAdminUrl(databaseUrl);
  try {
    await execAsync(
      `psql "${adminUrl}" -c "CREATE DATABASE ${testDbName};"`,
      { stdio: 'ignore' }
    ).catch(() => {
      // Database may already exist
    });
  } catch {
    // Fallback: use the main database for testing
    testDbUrl = databaseUrl;
  }

  if (!testDbUrl) {
    testDbUrl = buildTestDbUrl(databaseUrl, testDbName);
  }

  // Create Prisma client with test DB
  prisma = new PrismaClient({
    datasources: {
      db: { url: testDbUrl },
    },
  });

  // Run migrations using the server workspace directory
  const serverDir = join(__dirname, '..', 'server');
  try {
    await execAsync('npx prisma migrate deploy', {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: testDbUrl },
    });
  } catch (err: unknown) {
    const error = err as { stdout?: string; message?: string };
    // Migrations may already be applied; ignore errors
    console.log('Migration note:', error.stdout?.trim() || error.message);
  }

  await prisma.$connect();

  return {
    prisma,
    dbUrl: testDbUrl,
    cleanup: teardownTestDatabase,
  };
}

export async function teardownTestDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
  testDbUrl = null;
}

export function getPrisma(): PrismaClient {
  if (!prisma) {
    throw new Error('Test database not initialized. Call setupTestDatabase() first.');
  }
  return prisma;
}
