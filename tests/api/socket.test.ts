import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDatabase, teardownTestDatabase, getPrisma } from '../test-setup';
import { RoomStatus, ServerEvents, ClientEvents } from '@suetheirasses/shared';
import { io as ioClient, Socket as SocketClient } from 'socket.io-client';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { validateSubmitDecisions } from '../../server/src/validation/schemas';

describe('Socket.IO Integration', () => {
  let dbUrl: string;
  let io: Server;
  let httpServer: ReturnType<typeof createServer>;
  let port: number;
  let client: SocketClient;
  let connectedSocket: any = null;
  // First socket to connect is treated as the room host, mirroring gameEngine.ts's
  // real isHost check well enough to distinguish host/non-host in ROOM_KICK tests.
  let hostSocketId: string | null = null;

  beforeAll(async () => {
    const ctx = await setupTestDatabase();
    dbUrl = ctx.dbUrl;

    // Create a minimal HTTP + Socket.IO server for testing
    httpServer = createServer();
    io = new Server(httpServer, {
      cors: { origin: '*' },
    });

    // Mock socket handlers for testing
    io.on('connection', (socket) => {
      connectedSocket = socket;
      if (hostSocketId === null) hostSocketId = socket.id;

      socket.on(ClientEvents.ROOM_JOIN, (data: any) => {
        socket.emit(ServerEvents.ROOM_JOINED, {
          room: { id: 'test-room', status: RoomStatus.WAITING, maxPlayers: 4, currentPhaseRound: 1, players: [] },
          player: { id: socket.id, name: data.playerName, roomId: 'test-room', isHost: false, bankrupt: false },
          companies: [],
        });
      });

      socket.on(ClientEvents.ROOM_LIST, () => {
        socket.emit(ServerEvents.ROOMS_LISTED, {
          rooms: [
            { id: 'room-1', status: RoomStatus.WAITING, maxPlayers: 4, currentPhaseRound: 1, playerCount: 1 },
            { id: 'room-2', status: RoomStatus.WAITING, maxPlayers: 4, currentPhaseRound: 2, playerCount: 2 },
          ],
        });
      });

      socket.on(ClientEvents.CHAT_MESSAGE, (data: any) => {
        socket.emit(ServerEvents.CHAT_MESSAGE, { message: data.message });
      });

      // Mirrors gameEngine.ts's real ROOM_KICK handler's host check
      socket.on(ClientEvents.ROOM_KICK, (data: any) => {
        if (socket.id !== hostSocketId) {
          socket.emit(ServerEvents.ERROR, { code: 'NOT_HOST', message: 'Only the host can kick players' });
          return;
        }
        socket.emit(ServerEvents.ROOM_PLAYER_KICKED, {
          kickedPlayerId: data.playerId,
          kickedPlayerName: 'MockKickedPlayer',
        });
      });

      // Mirrors gameEngine.ts's real ROOM_START_GAME handler
      socket.on(ClientEvents.ROOM_START_GAME, () => {
        socket.emit(ServerEvents.PHASE_CHANGED, {
          phase: RoomStatus.GAME_PHASE,
          round: 1,
          timeLimit: 120,
        });
      });

      // Mirrors gameEngine.ts's real handler: validate with the actual Zod
      // schema, emit ERROR on failure, otherwise accept silently (no ack —
      // the player's choices are picked up on the next turn resolution).
      socket.on(ClientEvents.GAME_SUBMIT_DECISIONS, (payload: any) => {
        try {
          validateSubmitDecisions(payload);
        } catch (error: any) {
          socket.emit(ServerEvents.ERROR, {
            code: 'INVALID_DECISIONS',
            message: error.message || 'Invalid decision submission',
          });
        }
      });
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        port = typeof addr === 'object' && addr ? addr.port! : 3001;
        resolve();
      });
    });

    // Connect client and wait for it to be ready
    await new Promise<void>((resolve) => {
      client = ioClient(`http://localhost:${port}`, {
        transports: ['websocket'],
      });
      client.on('connect', resolve);
    });
  });

  afterAll(async () => {
    client?.disconnect();
    io?.close();
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    await teardownTestDatabase();
  });

  it('should connect and receive room:joined event', async () => {
    const joined = new Promise<any>((resolve) => {
      client.once(ServerEvents.ROOM_JOINED, resolve);
    });

    client.emit(ClientEvents.ROOM_JOIN, { playerName: 'TestPlayer' });
    const data = await joined;

    expect(data.room.id).toBe('test-room');
    expect(data.room.status).toBe(RoomStatus.WAITING);
    expect(data.player.name).toBe('TestPlayer');
  });

  it('should receive room:playerKicked event', async () => {
    const kicked = new Promise<any>((resolve) => {
      client.once(ServerEvents.ROOM_PLAYER_KICKED, resolve);
    });

    client.emit(ClientEvents.ROOM_KICK, { playerId: 'player-to-kick' });
    const data = await kicked;

    expect(data.kickedPlayerId).toBe('player-to-kick');
  });

  it('should receive error when non-host tries to kick a player', async () => {
    // `client` was the first socket to connect, so it's the mock host — use a
    // fresh, non-host connection to exercise the NOT_HOST rejection path.
    const nonHost = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
    await new Promise<void>((resolve) => nonHost.on('connect', resolve));

    const errorReceived = new Promise<any>((resolve) => {
      nonHost.once(ServerEvents.ERROR, resolve);
    });

    nonHost.emit(ClientEvents.ROOM_KICK, { playerId: 'player-to-kick' });
    const data = await errorReceived;

    expect(data.code).toBe('NOT_HOST');

    nonHost.disconnect();
  });

  it('should receive phase:changed event when host starts game', async () => {
    const phaseChanged = new Promise<any>((resolve) => {
      client.once(ServerEvents.PHASE_CHANGED, resolve);
    });

    client.emit(ClientEvents.ROOM_START_GAME);
    const data = await phaseChanged;

    expect(data.phase).toBe(RoomStatus.GAME_PHASE);
    expect(data.round).toBe(1);
    expect(data.timeLimit).toBeDefined();
  });

  it('should emit room:startGame event', async () => {
    // Verify the event can be emitted without error
    expect(() => {
      client.emit(ClientEvents.ROOM_START_GAME);
    }).not.toThrow();
  });

  it('should receive chat:message event', async () => {
    const chat = new Promise<any>((resolve) => {
      client.once(ServerEvents.CHAT_MESSAGE, resolve);
    });

    client.emit(ClientEvents.CHAT_MESSAGE, { message: 'Hello!' });
    const data = await chat;

    expect(data.message).toBe('Hello!');
  });

  it('should handle multiple concurrent connections', async () => {
    const c1 = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
    const c2 = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });

    const events: string[] = [];

    await Promise.all([
      new Promise<void>((resolve) => {
        c1.once(ServerEvents.ROOM_JOINED, () => {
          events.push('c1-joined');
          resolve();
        });
        c1.emit(ClientEvents.ROOM_JOIN, { playerName: 'Player1' });
      }),
      new Promise<void>((resolve) => {
        c2.once(ServerEvents.ROOM_JOINED, () => {
          events.push('c2-joined');
          resolve();
        });
        c2.emit(ClientEvents.ROOM_JOIN, { playerName: 'Player2' });
      }),
    ]);

    expect(events).toContain('c1-joined');
    expect(events).toContain('c2-joined');

    c1.disconnect();
    c2.disconnect();
  });

  it('should receive rooms:list event when requesting room list', async () => {
    const listed = new Promise<any>((resolve) => {
      client.once(ServerEvents.ROOMS_LISTED, resolve);
    });

    client.emit(ClientEvents.ROOM_LIST);
    const data = await listed;

    expect(data.rooms).toBeDefined();
    expect(data.rooms.length).toBe(2);
    expect(data.rooms[0].id).toBe('room-1');
    expect(data.rooms[0].maxPlayers).toBe(4);
    expect(data.rooms[0].playerCount).toBe(1);
  });

  it('should receive room:playerJoined event when another player joins', async () => {
    const joined = new Promise<any>((resolve) => {
      client.once(ServerEvents.ROOM_PLAYER_JOINED, resolve);
    });

    // Simulate server broadcasting a player join to the client socket
    // Use io.to() with the client's socket ID to send the event
    io.to(client.id).emit(ServerEvents.ROOM_PLAYER_JOINED, {
      playerId: 'player-2',
      playerName: 'NewPlayer',
      isHost: false,
      roomId: 'test-room',
    });

    const data = await joined;

    expect(data.playerId).toBe('player-2');
    expect(data.playerName).toBe('NewPlayer');
    expect(data.isHost).toBe(false);
    expect(data.roomId).toBe('test-room');
  });

  it('should validate room:join with searchForRoom flag', async () => {
    const joined = new Promise<any>((resolve) => {
      client.once(ServerEvents.ROOM_JOINED, resolve);
    });

    client.emit(ClientEvents.ROOM_JOIN, { playerName: 'QuickPlay', searchForRoom: true });
    const data = await joined;

    expect(data.room.id).toBe('test-room');
    expect(data.player.name).toBe('QuickPlay');
  });

  it('should have maxPlayers of 4 in room state', async () => {
    const joined = new Promise<any>((resolve) => {
      client.once(ServerEvents.ROOM_JOINED, resolve);
    });

    client.emit(ClientEvents.ROOM_JOIN, { playerName: 'MaxPlayersTest' });
    const data = await joined;

    expect(data.room.maxPlayers).toBe(4);
  });

  describe('game:submitDecisions', () => {
    it('should accept a valid decision submission without emitting an error', async () => {
      const errorPromise = new Promise<any>((resolve) => client.once(ServerEvents.ERROR, resolve));
      const noErrorPromise = new Promise<'no-error'>((resolve) => setTimeout(() => resolve('no-error'), 200));

      client.emit(ClientEvents.GAME_SUBMIT_DECISIONS, {
        strategic: [{ name: 'New Factory' }],
        operational: [{ name: 'Digital Marketing' }],
        financial: [],
        lawsuits: [],
      });

      const result = await Promise.race([errorPromise, noErrorPromise]);
      expect(result).toBe('no-error');
    });

    it('should accept a targeted decision with a targetId (e.g. Buy Shares)', async () => {
      const errorPromise = new Promise<any>((resolve) => client.once(ServerEvents.ERROR, resolve));
      const noErrorPromise = new Promise<'no-error'>((resolve) => setTimeout(() => resolve('no-error'), 200));

      client.emit(ClientEvents.GAME_SUBMIT_DECISIONS, {
        strategic: [],
        operational: [],
        financial: [{ name: 'Buy Shares', targetId: 'rival-player-id' }],
        lawsuits: [],
      });

      const result = await Promise.race([errorPromise, noErrorPromise]);
      expect(result).toBe('no-error');
    });

    it('should accept a deliberate lawsuit filing without emitting an error', async () => {
      const errorPromise = new Promise<any>((resolve) => client.once(ServerEvents.ERROR, resolve));
      const noErrorPromise = new Promise<'no-error'>((resolve) => setTimeout(() => resolve('no-error'), 200));

      client.emit(ClientEvents.GAME_SUBMIT_DECISIONS, {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'rival-player-id', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const result = await Promise.race([errorPromise, noErrorPromise]);
      expect(result).toBe('no-error');
    });

    it('should emit an error event for a structurally invalid decision submission', async () => {
      const errorReceived = new Promise<any>((resolve) => {
        client.once(ServerEvents.ERROR, resolve);
      });

      client.emit(ClientEvents.GAME_SUBMIT_DECISIONS, { strategic: [{ name: '' }], operational: [], financial: [], lawsuits: [] });
      const data = await errorReceived;

      expect(data.code).toBe('INVALID_DECISIONS');
    });
  });

  describe('turn:resolved', () => {
    it('should receive turn:resolved with per-player results when a turn is resolved', async () => {
      const resolved = new Promise<any>((resolve) => {
        client.once(ServerEvents.TURN_RESOLVED, resolve);
      });

      // Simulate the server broadcasting the end of a GameLoop.resolveTurn() call
      io.to(client.id).emit(ServerEvents.TURN_RESOLVED, {
        round: 1,
        players: [
          { playerId: 'player-1', playerName: 'Alice', variables: {}, derived: {}, activeDecisions: [], legalCases: [], riskGauge: 0 },
        ],
        gameOver: false,
      });

      const data = await resolved;

      expect(data.round).toBe(1);
      expect(data.gameOver).toBe(false);
      expect(data.players).toHaveLength(1);
      expect(data.players[0].playerId).toBe('player-1');
    });
  });

  describe('game:over', () => {
    it('should receive game:over with winner and final standings when only one player remains', async () => {
      const gameOver = new Promise<any>((resolve) => {
        client.once(ServerEvents.GAME_OVER, resolve);
      });

      // Simulate the server broadcasting once GameLoop.resolveTurn() reports gameOver
      io.to(client.id).emit(ServerEvents.GAME_OVER, {
        winner: { id: 'player-1', name: 'Alice', roomId: 'test-room', isHost: true, bankrupt: false },
        finalStandings: [
          { player: { id: 'player-1', name: 'Alice', roomId: 'test-room', isHost: true, bankrupt: false }, company: null, rank: 1 },
        ],
      });

      const data = await gameOver;

      expect(data.winner.id).toBe('player-1');
      expect(data.finalStandings).toHaveLength(1);
      expect(data.finalStandings[0].rank).toBe(1);
    });
  });
});
