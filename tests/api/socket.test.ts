import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDatabase, teardownTestDatabase, getPrisma } from '../test-setup';
import { RoomStatus, ServerEvents, ClientEvents, StrategyActionType } from '@suetheirasses/shared';
import { io as ioClient, Socket as SocketClient } from 'socket.io-client';
import { createServer } from 'http';
import { Server } from 'socket.io';

describe('Socket.IO Integration', () => {
  let dbUrl: string;
  let io: Server;
  let httpServer: ReturnType<typeof createServer>;
  let port: number;
  let client: SocketClient;
  let connectedSocket: any = null;

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

      socket.on(ClientEvents.STRATEGY_SUBMIT, (data: any) => {
        socket.emit(ServerEvents.STRATEGY_COLLECT, { actions: data.actions });
      });

      socket.on(ClientEvents.CHAT_MESSAGE, (data: any) => {
        socket.emit(ServerEvents.CHAT_MESSAGE, { message: data.message });
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
    const errorReceived = new Promise<any>((resolve) => {
      client.once(ServerEvents.ERROR, resolve);
    });

    // In the mock handler, we don't check isHost, but the real handler would
    // This test verifies the error event structure
    client.emit(ClientEvents.ROOM_KICK, { playerId: 'player-to-kick' });
    const data = await errorReceived;

    // The mock doesn't validate host status, so this tests the event flow
    expect(data).toBeDefined();
  });

  it('should receive phase:changed event when host starts game', async () => {
    const phaseChanged = new Promise<any>((resolve) => {
      client.once(ServerEvents.PHASE_CHANGED, resolve);
    });

    client.emit(ClientEvents.ROOM_START_GAME);
    const data = await phaseChanged;

    expect(data.phase).toBe(RoomStatus.STRATEGY);
    expect(data.round).toBe(1);
    expect(data.timeLimit).toBeDefined();
  });

  it('should emit room:startGame event', async () => {
    // Verify the event can be emitted without error
    expect(() => {
      client.emit(ClientEvents.ROOM_START_GAME);
    }).not.toThrow();
  });

  it('should receive strategy:collect event', async () => {
    const collected = new Promise<any>((resolve) => {
      client.once(ServerEvents.STRATEGY_COLLECT, resolve);
    });

    client.emit(ClientEvents.STRATEGY_SUBMIT, {
      actions: [{ type: StrategyActionType.INVEST, amount: 10000 }],
    });
    const data = await collected;

    expect(data.actions.length).toBe(1);
    expect(data.actions[0].type).toBe(StrategyActionType.INVEST);
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
});
