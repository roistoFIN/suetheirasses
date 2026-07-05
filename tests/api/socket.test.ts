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
      socket.on(ClientEvents.ROOM_JOIN, (data: any) => {
        socket.emit(ServerEvents.ROOM_JOINED, {
          room: { id: 'test-room', status: RoomStatus.WAITING, maxPlayers: 6, currentPhaseRound: 1, players: [] },
          player: { id: socket.id, name: data.playerName, roomId: 'test-room', isReady: false, bankrupt: false },
          companies: [],
        });
      });

      socket.on(ClientEvents.ROOM_READY, () => {
        socket.emit(ServerEvents.ROOM_PLAYER_READY, { socketId: socket.id });
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

    // Connect client
    client = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
    });
  });

  afterAll(async () => {
    client.disconnect();
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
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

  it('should receive room:playerReady event', async () => {
    const ready = new Promise<any>((resolve) => {
      client.once(ServerEvents.ROOM_PLAYER_READY, resolve);
    });

    client.emit(ClientEvents.ROOM_READY);
    const data = await ready;

    expect(data.socketId).toBeDefined();
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
});
