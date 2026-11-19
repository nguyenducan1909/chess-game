/**
 * Máy chủ Express + Socket.IO cho game Cờ Vua 3D Online.
 * - Authoritative server: mọi nước đi kiểm tra bằng chess.js, đồng hồ tính trên server
 * - Hỗ trợ đồng hồ cờ, đầu hàng, xin hòa, tái đấu, xử lý rớt mạng
 * - Chế độ dev (--dev): nhúng Vite middleware trên cùng 1 cổng (mặc định 3000)
 * - Chế độ production (npm start): phục vụ trực tiếp bản build tĩnh từ dist/
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { RoomManager } from './roomManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const distDir = path.join(rootDir, 'dist');

const PORT = Number(process.env.PORT) || 3000;
const isDevFlag = process.argv.includes('--dev');
const hasDistBuild = fs.existsSync(path.join(distDir, 'index.html'));
const useViteMiddleware = isDevFlag || (process.env.NODE_ENV !== 'production' && !hasDistBuild);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Header bảo mật cơ bản cho ứng dụng web
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: false },
  pingInterval: 10000,
  pingTimeout: 20000,
});

// Bộ giới hạn tần suất sự kiện (rate limit) theo từng socket để chống spam
const socketRateBuckets = new Map();
const chatRateBuckets = new Map();

function checkRateLimit(socketId, limit = 25, windowMs = 5000) {
  const now = Date.now();
  let timestamps = socketRateBuckets.get(socketId);
  if (!timestamps) {
    timestamps = [];
    socketRateBuckets.set(socketId, timestamps);
  }
  while (timestamps.length > 0 && now - timestamps[0] > windowMs) {
    timestamps.shift();
  }
  if (timestamps.length >= limit) {
    return false;
  }
  timestamps.push(now);
  return true;
}

/** Chống spam riêng cho chat: tối đa 5 tin / 5 giây và cách nhau tối thiểu 400ms */
function checkChatRateLimit(socketId) {
  const now = Date.now();
  let timestamps = chatRateBuckets.get(socketId);
  if (!timestamps) {
    timestamps = [];
    chatRateBuckets.set(socketId, timestamps);
  }
  while (timestamps.length > 0 && now - timestamps[0] > 5000) {
    timestamps.shift();
  }
  if (timestamps.length > 0 && now - timestamps[timestamps.length - 1] < 400) {
    return false;
  }
  if (timestamps.length >= 5) {
    return false;
  }
  timestamps.push(now);
  return true;
}

/** Khởi tạo RoomManager với các callback tự động broadcast đồng hồ / kết thúc ván */
const roomManager = new RoomManager({
  onClockUpdate: (room) => {
    io.to(room.id).emit('clock:sync', {
      clock: room.clock.getSnapshot(),
      players: roomManager.getPublicState(room, 'spectator').players,
    });
  },
  onGameEnded: (room) => {
    const snap = roomManager.getPublicState(room, 'spectator');
    io.to(room.id).emit('game:ended', {
      status: snap.status,
      result: snap.result,
      clock: snap.clock,
      drawOffer: null,
      rematchVotes: snap.rematchVotes,
    });
  },
  onNotice: (room, message) => {
    io.to(room.id).emit('room:notice', { message });
  },
});

/** Gửi trạng thái đầy đủ kèm role riêng cho từng thành viên đang kết nối trong phòng */
function emitRoomStateToEachMember(room) {
  if (room.players.w?.connected && room.players.w.socketId) {
    io.to(room.players.w.socketId).emit('room:state', roomManager.getPublicState(room, 'w'));
  }
  if (room.players.b?.connected && room.players.b.socketId) {
    io.to(room.players.b.socketId).emit('room:state', roomManager.getPublicState(room, 'b'));
  }
  for (const specSocketId of room.spectators.keys()) {
    io.to(specSocketId).emit('room:state', roomManager.getPublicState(room, 'spectator'));
  }
}

/** Broadcast cập nhật người chơi, đồng hồ & lời mời hòa/tái đấu cho cả phòng */
function emitPlayersUpdate(room) {
  const snapshot = roomManager.getPublicState(room, 'spectator');
  io.to(room.id).emit('room:players', {
    players: snapshot.players,
    spectatorCount: snapshot.spectatorCount,
    status: snapshot.status,
    clock: snapshot.clock,
    drawOffer: snapshot.drawOffer,
    rematchVotes: snapshot.rematchVotes,
  });
}

// --- Socket.IO Events ---
io.on('connection', (socket) => {
  // 1. Tham gia phòng / reconnect
  socket.on('room:join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!checkRateLimit(socket.id, 15, 5000)) {
      return reply({ ok: false, code: 'RATE_LIMITED', error: 'Bạn thao tác quá nhanh, vui lòng thử lại sau.' });
    }

    const { roomId, playerId, playerName } = payload || {};
    const result = roomManager.joinRoom({
      roomId,
      playerId,
      playerName,
      socketId: socket.id,
    });

    if (!result.ok) {
      return reply({ ok: false, code: result.code, error: result.error });
    }

    if (result.replacedSocketId) {
      const oldSocket = io.sockets.sockets.get(result.replacedSocketId);
      if (oldSocket) {
        oldSocket.leave(result.room.id);
        oldSocket.emit('room:replaced', {
          message: 'Bạn đã mở phòng này ở một tab hoặc thiết bị khác.',
        });
      }
    }

    socket.join(result.room.id);
    reply({ ok: true, state: result.state, reconnected: result.reconnected });
    emitPlayersUpdate(result.room);
  });

  // 2. Nước đi (authoritative + đồng bộ đồng hồ)
  socket.on('game:move', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!checkRateLimit(socket.id, 25, 5000)) {
      return reply({ ok: false, error: 'Thao tác quá nhanh, vui lòng chậm lại.' });
    }

    const { from, to, promotion } = payload || {};
    const result = roomManager.applyMove({
      socketId: socket.id,
      from,
      to,
      promotion,
    });

    if (!result.ok) {
      return reply({ ok: false, error: result.error, fen: result.fen });
    }

    const room = result.room;
    const publicState = roomManager.getPublicState(room, 'spectator');

    io.to(room.id).emit('game:moved', {
      move: result.move,
      fen: publicState.fen,
      turn: publicState.turn,
      inCheck: publicState.inCheck,
      history: publicState.history,
      lastMove: publicState.lastMove,
      status: publicState.status,
      result: publicState.result,
      clock: publicState.clock,
      drawOffer: publicState.drawOffer,
    });

    return reply({ ok: true, move: result.move });
  });

  // 3. Đầu hàng
  socket.on('game:resign', (_payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!checkRateLimit(socket.id, 8, 5000)) {
      return reply({ ok: false, error: 'Thao tác quá nhanh.' });
    }

    const res = roomManager.resign(socket.id);
    if (!res.ok) {
      return reply({ ok: false, error: res.error });
    }

    const snap = roomManager.getPublicState(res.room, 'spectator');
    io.to(res.room.id).emit('game:ended', {
      status: snap.status,
      result: snap.result,
      clock: snap.clock,
      drawOffer: null,
      rematchVotes: snap.rematchVotes,
    });

    return reply({ ok: true });
  });

  // 4. Đề nghị hòa
  socket.on('game:draw-offer', (_payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!checkRateLimit(socket.id, 8, 5000)) {
      return reply({ ok: false, error: 'Thao tác quá nhanh.' });
    }

    const res = roomManager.offerDraw(socket.id);
    if (!res.ok) {
      return reply({ ok: false, error: res.error });
    }

    const snap = roomManager.getPublicState(res.room, 'spectator');
    if (res.acceptedImmediately) {
      io.to(res.room.id).emit('game:ended', {
        status: snap.status,
        result: snap.result,
        clock: snap.clock,
        drawOffer: null,
        rematchVotes: snap.rematchVotes,
      });
    } else {
      io.to(res.room.id).emit('game:draw-offer', {
        drawOffer: snap.drawOffer,
      });
    }

    return reply({ ok: true, acceptedImmediately: res.acceptedImmediately });
  });

  // 5. Chấp nhận hoặc từ chối lời đề nghị hòa
  socket.on('game:draw-respond', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!checkRateLimit(socket.id, 8, 5000)) {
      return reply({ ok: false, error: 'Thao tác quá nhanh.' });
    }

    const accept = Boolean(payload?.accept);
    const res = roomManager.respondDraw(socket.id, accept);
    if (!res.ok) {
      return reply({ ok: false, error: res.error });
    }

    const snap = roomManager.getPublicState(res.room, 'spectator');
    if (res.accepted) {
      io.to(res.room.id).emit('game:ended', {
        status: snap.status,
        result: snap.result,
        clock: snap.clock,
        drawOffer: null,
        rematchVotes: snap.rematchVotes,
      });
    } else {
      io.to(res.room.id).emit('game:draw-offer', {
        drawOffer: null,
        declinedBy: res.declinedBy,
      });
    }

    return reply({ ok: true, accepted: res.accepted });
  });

  // 6. Tái đấu (chơi lại ván mới)
  socket.on('game:rematch', (_payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!checkRateLimit(socket.id, 10, 5000)) {
      return reply({ ok: false, error: 'Thao tác quá nhanh.' });
    }

    const res = roomManager.requestRematch(socket.id);
    if (!res.ok) {
      return reply({ ok: false, error: res.error });
    }

    if (res.started) {
      emitRoomStateToEachMember(res.room);
      io.to(res.room.id).emit('room:notice', {
        message: 'Ván mới đã bắt đầu (đã đổi màu quân và đặt lại đồng hồ)!',
      });
    } else {
      emitPlayersUpdate(res.room);
    }

    return reply({ ok: true, started: res.started });
  });

  // 7. Chat realtime giữa 2 người chơi (có rate limit chống spam & escape HTML)
  socket.on('chat:send', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!checkRateLimit(socket.id, 25, 5000) || !checkChatRateLimit(socket.id)) {
      return reply({ ok: false, error: 'Bạn đang gửi tin nhắn quá nhanh, vui lòng đợi chút.' });
    }

    const res = roomManager.addChatMessage({
      socketId: socket.id,
      text: payload?.text,
    });

    if (!res.ok) {
      return reply({ ok: false, error: res.error });
    }

    io.to(res.room.id).emit('chat:message', res.message);
    return reply({ ok: true, message: res.message });
  });

  // 8. Ngắt kết nối
  socket.on('disconnect', () => {
    socketRateBuckets.delete(socket.id);
    chatRateBuckets.delete(socket.id);
    const left = roomManager.leaveBySocket(socket.id);
    if (left?.room) {
      emitPlayersUpdate(left.room);
    }
  });
});

// Dọn phòng không hoạt động mỗi 5 phút
const cleanupTimer = setInterval(() => {
  const removed = roomManager.cleanupInactiveRooms();
  if (removed > 0) {
    console.log(`[RoomManager] Đã dọn ${removed} phòng không hoạt động.`);
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

// --- Express HTTP Routes ---
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: roomManager.rooms.size });
});

// Tạo phòng ngẫu nhiên (hỗ trợ ?tc=3+2 | 5+0 | 10+0 | 15+10 | unlimited) và redirect tới /room/:id
app.get('/new', (req, res) => {
  const tc = typeof req.query.tc === 'string' ? req.query.tc : undefined;
  const room = roomManager.createRoom({ timeControlId: tc });
  res.redirect(302, `/room/${room.id}`);
});

app.get('/api/rooms/:id', (req, res) => {
  const room = roomManager.getRoom(req.params.id);
  if (!room) {
    return res.status(404).json({ ok: false, error: 'Phòng không tồn tại.' });
  }
  return res.json({
    ok: true,
    roomId: room.id,
    status: room.status,
    timeControl: room.clock.config.id,
    hasWhite: Boolean(room.players.w),
    hasBlack: Boolean(room.players.b),
    spectatorCount: room.spectators.size,
  });
});

// Phục vụ model 3D với cache HTTP để reload / mở tab 2 nhanh hơn
app.use(
  '/models',
  express.static(path.join(publicDir, 'models'), {
    maxAge: '7d',
    etag: true,
    lastModified: true,
  })
);

async function startServer() {
  if (useViteMiddleware) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: rootDir,
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.use(express.static(publicDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    const modeLabel = useViteMiddleware ? 'DEV (Vite middleware)' : 'PRODUCTION (dist/)';
    console.log(`\n==================================================`);
    console.log(`  Cờ Vua 3D Online đang chạy [${modeLabel}]`);
    console.log(`  Trang chủ : http://localhost:${PORT}`);
    console.log(`  Tạo phòng : http://localhost:${PORT}/new`);
    console.log(`==================================================\n`);
  });

  // Tắt máy chủ êm gọn khi nhận tín hiệu dừng (hữu ích trên Render / Railway / Fly.io)
  const shutdown = (signal) => {
    console.log(`\n[Server] Nhận tín hiệu ${signal}, đang dừng máy chủ...`);
    clearInterval(cleanupTimer);
    roomManager.disposeAll();
    io.close();
    httpServer.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('Lỗi khởi động server:', err);
  process.exit(1);
});
