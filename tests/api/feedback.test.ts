import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDatabase, teardownTestDatabase, getPrisma } from '../test-setup';

// Matches this test layer's existing convention (see room.test.ts) — a real Prisma
// round trip against a real Postgres schema (via testcontainers/migrate deploy), not an
// HTTP-level test of the Express routes themselves (nothing in this suite spins up the
// actual app — see socket.test.ts, which builds its own bare httpServer/io instead of
// importing server/src/index.ts). What matters here is that the `Feedback` model/
// migration round-trips correctly, since POST /api/feedback and GET /api/admin/feedback
// (server/src/index.ts) are thin wrappers around exactly this: `prisma.feedback.create`
// and `prisma.feedback.findMany({ orderBy: { createdAt: 'desc' } })`.
describe('Feedback REST API', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  it('creates a feedback row with a rating, message, and source — deliberately no player/room id anywhere on the model', async () => {
    const prisma = getPrisma();

    const created = await prisma.feedback.create({
      data: { rating: 5, message: 'Loved the courtroom drama!', source: 'gameover' },
    });

    expect(created.id).toBeDefined();
    expect(created.rating).toBe(5);
    expect(created.message).toBe('Loved the courtroom drama!');
    expect(created.source).toBe('gameover');
    expect(created.createdAt).toBeInstanceOf(Date);
    expect((created as any).playerId).toBeUndefined();
    expect((created as any).roomId).toBeUndefined();

    await prisma.feedback.delete({ where: { id: created.id } });
  });

  it('allows an omitted message — the Likert rating alone is a complete submission', async () => {
    const prisma = getPrisma();

    const created = await prisma.feedback.create({
      data: { rating: 2, source: 'landing' },
    });

    expect(created.message).toBeNull();

    await prisma.feedback.delete({ where: { id: created.id } });
  });

  it('reads feedback back ordered newest-first, matching GET /api/admin/feedback\'s own query', async () => {
    const prisma = getPrisma();
    const older = await prisma.feedback.create({ data: { rating: 1, source: 'landing' } });
    // Ensure a distinguishable createdAt ordering even on a fast machine.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const newer = await prisma.feedback.create({ data: { rating: 5, source: 'gameover' } });

    const rows = await prisma.feedback.findMany({
      where: { id: { in: [older.id, newer.id] } },
      orderBy: { createdAt: 'desc' },
    });

    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);

    await prisma.feedback.deleteMany({ where: { id: { in: [older.id, newer.id] } } });
  });
});
