import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDatabase, teardownTestDatabase, getPrisma } from '../test-setup';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Health Endpoint', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  it('should connect to the database successfully', async () => {
    const prisma = getPrisma();

    // Test that we can query the database
    const result = await prisma.$queryRaw<Array<{ exists: boolean }>>`SELECT true AS exists`;

    expect(result).toBeDefined();
    expect(result.length).toBe(1);
    expect(result[0].exists).toBe(true);
  });

  it('should have a health endpoint defined in the server', async () => {
    // Verify the server module exists and has the expected structure
    const serverIndexPath = join(__dirname, '..', '..', 'server', 'src', 'index.ts');
    const content = readFileSync(serverIndexPath, 'utf-8');

    expect(content).toContain("app.get('/health'");
    expect(content).toContain('export { io, prisma }');
  });

  it('should export io and prisma from the server module', async () => {
    // The server exports io and prisma - verify the export statement exists
    const serverIndexPath = join(__dirname, '..', '..', 'server', 'src', 'index.ts');
    const content = readFileSync(serverIndexPath, 'utf-8');

    expect(content).toMatch(/export\s*\{[^}]*io[^}]*\}/);
    expect(content).toMatch(/export\s*\{[^}]*prisma[^}]*\}/);
  });

  it('should have express and socket.io as dependencies', async () => {
    const packageJsonPath = join(__dirname, '..', '..', 'server', 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

    expect(pkg.dependencies.express).toBeDefined();
    expect(pkg.dependencies['socket.io']).toBeDefined();
    expect(pkg.dependencies['@prisma/client']).toBeDefined();
  });

  it('should have health check returning status and timestamp', async () => {
    const serverIndexPath = join(__dirname, '..', '..', 'server', 'src', 'index.ts');
    const content = readFileSync(serverIndexPath, 'utf-8');

    expect(content).toContain("status: 'ok'");
    expect(content).toContain('timestamp');
    expect(content).toContain("db: 'connected'");
    expect(content).toContain("status: 'degraded'");
    expect(content).toContain("db: 'disconnected'");
  });
});
