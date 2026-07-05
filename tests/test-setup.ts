import { PrismaClient } from '@prisma/client';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let prisma: PrismaClient | null = null;
let testDbUrl: string | null = null;

export interface TestDbContext {
  prisma: PrismaClient;
  dbUrl: string;
  cleanup: () => Promise<void>;
}

export async function setupTestDatabase(): Promise<TestDbContext> {
  if (prisma && testDbUrl) {
    return { prisma, dbUrl: testDbUrl, cleanup: teardownTestDatabase };
  }

  // Use the existing PostgreSQL instance from docker-compose
  // or fall back to a test-specific database
  testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://stita:stita_password@localhost:5432/stita_db_test';

  // Create test database if it doesn't exist
  const adminUrl = 'postgresql://stita:stita_password@localhost:5432/stita_db';
  try {
    await execAsync(
      `psql "${adminUrl}" -c "CREATE DATABASE stita_db_test;"`,
      { stdio: 'ignore' }
    ).catch(() => {
      // Database may already exist
    });
  } catch {
    // Fallback: use the main database for testing
    testDbUrl = 'postgresql://stita:stita_password@localhost:5432/stita_db';
  }

  // Create Prisma client with test DB
  prisma = new PrismaClient({
    datasources: {
      db: { url: testDbUrl },
    },
  });

  // Run migrations
  try {
    await execAsync('npx prisma migrate deploy', {
      cwd: '/home/roisto/Projects/suetheirasses/server',
      env: { ...process.env, DATABASE_URL: testDbUrl },
    });
  } catch (err: any) {
    // Migrations may already be applied; ignore errors
    console.log('Migration note:', err.stdout?.trim() || err.message);
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
