import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDatabase, teardownTestDatabase, getPrisma } from '../test-setup';
import { RoomStatus } from '@suetheirasses/shared';

describe('Room REST API', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  it('should create a room and player in the database', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-1`;
    const playerId = `player-${roomId}`;

    const room = await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
        players: {
          create: {
            id: playerId,
            name: 'TestPlayer',
            isReady: true,
            companyId: `company-${playerId}`,
            socketId: `socket-${playerId}`,
            company: {
              create: {
                cash: 100000,
              },
            },
          },
        },
      },
      include: {
        players: { include: { company: true } },
      },
    });

    expect(room.id).toBe(roomId);
    expect(room.status).toBe(RoomStatus.WAITING);
    expect(room.maxPlayers).toBe(4);
    expect(room.players.length).toBe(1);
    expect(room.players[0].name).toBe('TestPlayer');
    expect(room.players[0].companyId).toBeDefined();
    expect(room.players[0].socketId).toBeDefined();
    expect(Number(room.players[0].company?.cash)).toBe(100000);

    // Cleanup
    await prisma.player.delete({ where: { id: playerId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should find a room by ID', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-2`;
    const playerId = `player-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
        players: {
          create: {
            id: playerId,
            name: 'Finder',
            isReady: true,
            companyId: `company-${playerId}`,
            socketId: `socket-${playerId}`,
            company: { create: { cash: 100000 } },
          },
        },
      },
    });

    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: {
        players: { include: { company: { include: { assets: true } } } },
      },
    });

    expect(room).not.toBeNull();
    expect(room?.id).toBe(roomId);
    expect(room?.players[0].company?.assets).toBeDefined();

    await prisma.player.delete({ where: { id: playerId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should return null for non-existent room', async () => {
    const prisma = getPrisma();

    const room = await prisma.room.findUnique({
      where: { id: 'non-existent-room' },
    });

    expect(room).toBeNull();
  });

  it('should update room status', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-3`;
    const playerId = `player-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
        players: {
          create: {
            id: playerId,
            name: 'StatusTester',
            isReady: true,
            companyId: `company-${playerId}`,
            socketId: `socket-${playerId}`,
            company: { create: { cash: 100000 } },
          },
        },
      },
    });

    await prisma.room.update({
      where: { id: roomId },
      data: { status: RoomStatus.STRATEGY },
    });

    const room = await prisma.room.findUnique({
      where: { id: roomId },
    });

    expect(room?.status).toBe(RoomStatus.STRATEGY);

    await prisma.player.delete({ where: { id: playerId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should increment phase round', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-4`;
    const playerId = `player-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
        currentPhaseRound: 1,
        players: {
          create: {
            id: playerId,
            name: 'RoundTester',
            isReady: true,
            companyId: `company-${playerId}`,
            socketId: `socket-${playerId}`,
            company: { create: { cash: 100000 } },
          },
        },
      },
    });

    await prisma.room.update({
      where: { id: roomId },
      data: { currentPhaseRound: { increment: 1 } },
    });

    const room = await prisma.room.findUnique({
      where: { id: roomId },
    });

    expect(room?.currentPhaseRound).toBe(2);

    await prisma.player.delete({ where: { id: playerId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should create and retrieve a player with company', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-5`;
    const playerId = `player-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    const player = await prisma.player.create({
      data: {
        id: playerId,
        name: 'PlayerTwo',
        roomId: roomId,
        companyId: `company-${playerId}`,
        socketId: `socket-${playerId}`,
        company: {
          create: {
            cash: 50000,
          },
        },
      },
      include: { company: true },
    });

    expect(player.id).toBe(playerId);
    expect(player.name).toBe('PlayerTwo');
    expect(player.companyId).toBeDefined();
    expect(player.socketId).toBeDefined();
    expect(Number(player.company?.cash)).toBe(50000);

    await prisma.player.delete({ where: { id: playerId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should update player company cash', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-6`;
    const playerId = `player-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    await prisma.player.create({
      data: {
        id: playerId,
        name: 'CashPlayer',
        roomId: roomId,
        companyId: `company-${playerId}`,
        socketId: `socket-${playerId}`,
        company: { create: { cash: 50000 } },
      },
    });

    await prisma.company.update({
      where: { playerId: playerId },
      data: { cash: { increment: 10000 } },
    });

    const player = await prisma.player.findUnique({
      where: { id: playerId },
      include: { company: true },
    });

    expect(player?.company?.cash).toBeDefined();
    expect(Number(player?.company?.cash)).toBe(60000);

    await prisma.player.delete({ where: { id: playerId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should delete player and company on cascade', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-7`;
    const playerId = `player-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    await prisma.player.create({
      data: {
        id: playerId,
        name: 'CascadePlayer',
        roomId: roomId,
        companyId: `company-${playerId}`,
        socketId: `socket-${playerId}`,
        company: { create: { cash: 100000 } },
      },
    });

    await prisma.player.delete({
      where: { id: playerId },
    });

    const player = await prisma.player.findUnique({
      where: { id: playerId },
    });

    expect(player).toBeNull();

    const company = await prisma.company.findUnique({
      where: { playerId: playerId },
    });

    expect(company).toBeNull();

    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should create an asset for a company', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-8`;
    const playerId = `player-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    await prisma.player.create({
      data: {
        id: playerId,
        name: 'AssetPlayer',
        roomId: roomId,
        companyId: `company-${playerId}`,
        socketId: `socket-${playerId}`,
        company: { create: { cash: 100000 } },
      },
    });

    const company = await prisma.company.findUnique({
      where: { playerId: playerId },
    });

    expect(company).not.toBeNull();

    const asset = await prisma.asset.create({
      data: {
        companyId: company!.id,
        type: 'Equipment',
        value: 25000,
      },
    });

    expect(asset.type).toBe('Equipment');
    expect(Number(asset.value)).toBe(25000);

    const companyWithAssets = await prisma.company.findUnique({
      where: { playerId: playerId },
      include: { assets: true },
    });

    expect(companyWithAssets?.assets.length).toBe(1);

    await prisma.player.delete({ where: { id: playerId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should delete assets on company cascade delete', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-9`;
    const playerId = `player-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    await prisma.player.create({
      data: {
        id: playerId,
        name: 'AssetDeletePlayer',
        roomId: roomId,
        companyId: `company-${playerId}`,
        socketId: `socket-${playerId}`,
        company: { create: { cash: 100000 } },
      },
    });

    const company = await prisma.company.findUnique({
      where: { playerId: playerId },
    });

    await prisma.asset.create({
      data: {
        companyId: company!.id,
        type: 'Vehicle',
        value: 50000,
      },
    });

    const companyWithAssets = await prisma.company.findUnique({
      where: { playerId: playerId },
      include: { assets: true },
    });

    expect(companyWithAssets?.assets.length).toBe(1);

    await prisma.player.delete({
      where: { id: playerId },
    });

    const deletedCompany = await prisma.company.findUnique({
      where: { playerId: playerId },
    });

    expect(deletedCompany).toBeNull();

    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should create and query lawsuits', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-10`;
    const plaintiffId = `plaintiff-${roomId}`;
    const defendantId = `defendant-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    const plaintiff = await prisma.player.create({
      data: {
        id: plaintiffId,
        name: 'Plaintiff',
        roomId: roomId,
        companyId: `company-${plaintiffId}`,
        socketId: `socket-${plaintiffId}`,
        company: { create: { cash: 100000 } },
      },
    });

    const defendant = await prisma.player.create({
      data: {
        id: defendantId,
        name: 'Defendant',
        roomId: roomId,
        companyId: `company-${defendantId}`,
        socketId: `socket-${defendantId}`,
        company: { create: { cash: 100000 } },
      },
    });

    const lawsuit = await prisma.lawsuit.create({
      data: {
        id: `lawsuit-${roomId}`,
        plaintiffId: plaintiff.id,
        defendantId: defendant.id,
        claimAmount: 50000,
        grounds: 'Breach of contract and negligence',
        resolved: false,
      },
    });

    expect(lawsuit.id).toBe(`lawsuit-${roomId}`);
    expect(lawsuit.resolved).toBe(false);
    expect(Number(lawsuit.claimAmount)).toBe(50000);

    const plaintiffLawsuits = await prisma.lawsuit.findMany({
      where: { plaintiffId: plaintiff.id, resolved: false },
    });

    expect(plaintiffLawsuits.length).toBe(1);

    const defendantLawsuits = await prisma.lawsuit.findMany({
      where: { defendantId: defendant.id, resolved: false },
    });

    expect(defendantLawsuits.length).toBe(1);

    await prisma.player.delete({ where: { id: plaintiffId } });
    await prisma.player.delete({ where: { id: defendantId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should resolve a lawsuit with verdict', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-11`;
    const plaintiffId = `plaintiff-${roomId}`;
    const defendantId = `defendant-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    const plaintiff = await prisma.player.create({
      data: {
        id: plaintiffId,
        name: 'Plaintiff',
        roomId: roomId,
        companyId: `company-${plaintiffId}`,
        socketId: `socket-${plaintiffId}`,
        company: { create: { cash: 100000 } },
      },
    });

    const defendant = await prisma.player.create({
      data: {
        id: defendantId,
        name: 'Defendant',
        roomId: roomId,
        companyId: `company-${defendantId}`,
        socketId: `socket-${defendantId}`,
        company: { create: { cash: 100000 } },
      },
    });

    const lawsuitId = `lawsuit-${roomId}`;
    await prisma.lawsuit.create({
      data: {
        id: lawsuitId,
        plaintiffId: plaintiff.id,
        defendantId: defendant.id,
        claimAmount: 50000,
        grounds: 'Breach of contract',
        resolved: false,
      },
    });

    await prisma.lawsuit.update({
      where: { id: lawsuitId },
      data: {
        resolved: true,
        verdict: 'WON',
        resolution: 'Court rules in favor of plaintiff',
      },
    });

    const lawsuit = await prisma.lawsuit.findUnique({
      where: { id: lawsuitId },
    });

    expect(lawsuit?.resolved).toBe(true);
    expect(lawsuit?.verdict).toBe('WON');
    expect(lawsuit?.resolution).toContain('plaintiff');

    await prisma.player.delete({ where: { id: plaintiffId } });
    await prisma.player.delete({ where: { id: defendantId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should transfer money on lawsuit verdict WON', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-12`;
    const plaintiffId = `plaintiff-${roomId}`;
    const defendantId = `defendant-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    const plaintiff = await prisma.player.create({
      data: {
        id: plaintiffId,
        name: 'Plaintiff',
        roomId: roomId,
        companyId: `company-${plaintiffId}`,
        socketId: `socket-${plaintiffId}`,
        company: { create: { cash: 100000 } },
      },
    });

    const defendant = await prisma.player.create({
      data: {
        id: defendantId,
        name: 'Defendant',
        roomId: roomId,
        companyId: `company-${defendantId}`,
        socketId: `socket-${defendantId}`,
        company: { create: { cash: 100000 } },
      },
    });

    const plaintiffCashBefore = Number((await prisma.company.findUnique({ where: { playerId: plaintiffId } }))?.cash);
    const defendantCashBefore = Number((await prisma.company.findUnique({ where: { playerId: defendantId } }))?.cash);

    await prisma.$transaction(async (tx) => {
      await tx.company.update({
        where: { playerId: defendantId },
        data: { cash: { decrement: 50000 } },
      });
      await tx.company.update({
        where: { playerId: plaintiffId },
        data: { cash: { increment: 50000 } },
      });
    });

    const plaintiffAfter = await prisma.player.findUnique({
      where: { id: plaintiffId },
      include: { company: true },
    });

    const defendantAfter = await prisma.player.findUnique({
      where: { id: defendantId },
      include: { company: true },
    });

    expect(Number(plaintiffAfter?.company?.cash)).toBe(plaintiffCashBefore + 50000);
    expect(Number(defendantAfter?.company?.cash)).toBe(defendantCashBefore - 50000);

    await prisma.player.delete({ where: { id: plaintiffId } });
    await prisma.player.delete({ where: { id: defendantId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should mark player as bankrupt', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-13`;
    const playerId = `player-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    await prisma.player.create({
      data: {
        id: playerId,
        name: 'BankruptPlayer',
        roomId: roomId,
        companyId: `company-${playerId}`,
        socketId: `socket-${playerId}`,
        company: { create: { cash: 100000 } },
      },
    });

    await prisma.player.update({
      where: { id: playerId },
      data: { bankrupt: true },
    });

    const player = await prisma.player.findUnique({
      where: { id: playerId },
    });

    expect(player?.bankrupt).toBe(true);

    await prisma.player.delete({ where: { id: playerId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should query players by room and bankrupt status', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-14`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    await prisma.player.create({
      data: {
        id: `active-${roomId}`,
        name: 'ActivePlayer',
        roomId: roomId,
        companyId: `company-active-${roomId}`,
        socketId: `socket-active-${roomId}`,
        company: { create: { cash: 100000 } },
      },
    });

    await prisma.player.create({
      data: {
        id: `bankrupt-${roomId}`,
        name: 'BankruptPlayer',
        roomId: roomId,
        bankrupt: true,
        companyId: `company-bankrupt-${roomId}`,
        socketId: `socket-bankrupt-${roomId}`,
        company: { create: { cash: 0 } },
      },
    });

    const activePlayers = await prisma.player.findMany({
      where: { roomId: roomId, bankrupt: false },
    });

    const bankruptPlayers = await prisma.player.findMany({
      where: { roomId: roomId, bankrupt: true },
    });

    expect(activePlayers.length).toBe(1);
    expect(bankruptPlayers.length).toBe(1);

    await prisma.player.delete({ where: { id: `active-${roomId}` } });
    await prisma.player.delete({ where: { id: `bankrupt-${roomId}` } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should clean up lawsuits on player cascade delete', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-15`;
    const plaintiffId = `plaintiff-${roomId}`;
    const defendantId = `defendant-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    const plaintiff = await prisma.player.create({
      data: {
        id: plaintiffId,
        name: 'Plaintiff',
        roomId: roomId,
        companyId: `company-${plaintiffId}`,
        socketId: `socket-${plaintiffId}`,
        company: { create: { cash: 100000 } },
      },
    });

    await prisma.player.create({
      data: {
        id: defendantId,
        name: 'Defendant',
        roomId: roomId,
        companyId: `company-${defendantId}`,
        socketId: `socket-${defendantId}`,
        company: { create: { cash: 100000 } },
      },
    });

    await prisma.lawsuit.create({
      data: {
        id: `lawsuit-${roomId}`,
        plaintiffId: plaintiff.id,
        defendantId: defendantId,
        claimAmount: 50000,
        grounds: 'Breach of contract',
        resolved: false,
      },
    });

    await prisma.player.delete({
      where: { id: plaintiffId },
    });

    const lawsuits = await prisma.lawsuit.findMany({
      where: { plaintiffId: plaintiffId },
    });

    expect(lawsuits.length).toBe(0);

    await prisma.player.delete({ where: { id: defendantId } });
    await prisma.room.delete({ where: { id: roomId } });
  });

  it('should clean up lawsuits on defendant cascade delete', async () => {
    const prisma = getPrisma();
    const roomId = `room-${Date.now()}-16`;
    const plaintiffId = `plaintiff-${roomId}`;
    const defendantId = `defendant-${roomId}`;

    await prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 4,
      },
    });

    await prisma.player.create({
      data: {
        id: plaintiffId,
        name: 'Plaintiff',
        roomId: roomId,
        companyId: `company-${plaintiffId}`,
        socketId: `socket-${plaintiffId}`,
        company: { create: { cash: 100000 } },
      },
    });

    const defendant = await prisma.player.create({
      data: {
        id: defendantId,
        name: 'Defendant',
        roomId: roomId,
        companyId: `company-${defendantId}`,
        socketId: `socket-${defendantId}`,
        company: { create: { cash: 100000 } },
      },
    });

    await prisma.lawsuit.create({
      data: {
        id: `lawsuit-${roomId}`,
        plaintiffId: plaintiffId,
        defendantId: defendant.id,
        claimAmount: 50000,
        grounds: 'Breach of contract',
        resolved: false,
      },
    });

    await prisma.player.delete({
      where: { id: defendantId },
    });

    const lawsuits = await prisma.lawsuit.findMany({
      where: { defendantId: defendantId },
    });

    expect(lawsuits.length).toBe(0);

    await prisma.player.delete({ where: { id: plaintiffId } });
    await prisma.room.delete({ where: { id: roomId } });
  });
});
