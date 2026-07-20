import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { setupSocketHandlers } from './socket/gameEngine.js';
import { requireAdminToken } from './middleware/adminAuth.js';
import gameConfigData from './data/game_config.json' with { type: 'json' };

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
});

// Allowed origins: Vite dev (:5173), Docker client (:80), and any custom origins from CLIENT_URL
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://localhost:80', 'http://localhost'];
const allowedOrigins = process.env.CLIENT_URL
  ? [...new Set([...process.env.CLIENT_URL.split(',').map((url) => url.trim()), ...DEFAULT_ORIGINS])]
  : DEFAULT_ORIGINS;

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());

// Health check endpoint
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', timestamp: new Date().toISOString(), db: 'connected' });
  } catch {
    res.status(503).json({ status: 'degraded', timestamp: new Date().toISOString(), db: 'disconnected' });
  }
});

// REST endpoint: get room info
app.get('/api/room/:roomId', async (req, res) => {
  try {
    const room = await prisma.room.findUnique({
      where: { id: req.params.roomId },
      include: {
        players: { include: { company: { include: { assets: true } } } },
      },
    });
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    res.json(room);
  } catch (error) {
    console.error('Error fetching room:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Socket.IO setup
const engine = setupSocketHandlers(io, prisma);

// Admin portal REST endpoints — gated by ADMIN_TOKEN (see middleware/adminAuth.ts).
// Read-only for now: room monitoring + the game config the server loaded at startup.
app.get('/api/admin/rooms', requireAdminToken, (_req, res) => {
  res.json({ rooms: engine.getAdminRoomsSnapshot() });
});

app.get('/api/admin/config', requireAdminToken, (_req, res) => {
  res.json(gameConfigData);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  engine.stop();
  await prisma.$disconnect();
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Start server with DB readiness check
async function start() {
  try {
    await prisma.$connect();
    console.log('Database connected');
    httpServer.listen(PORT, () => {
      console.log(`Game server running on port ${PORT}`);
      console.log(`Socket.IO server ready`);
    });
  } catch (error) {
    console.error('Failed to connect to database:', error);
    process.exit(1);
  }
}

start();

export { io, prisma };
