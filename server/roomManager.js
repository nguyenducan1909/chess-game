/**
 * Quản lý phòng chơi cờ vua trong bộ nhớ server (Map - không dùng database).
 * Server là nguồn chân lý duy nhất (authoritative):
 * - Mọi nước đi kiểm tra bằng chess.js
 * - Đồng hồ tính hoàn toàn trên server (server/clock.js)
 * - Quản lý đầu hàng, xin hòa, tái đấu, và xử lý rớt mạng (grace period + bỏ cuộc)
 */

import crypto from 'node:crypto';
import { Chess } from 'chess.js';
import { ChessClock, resolveTimeControl, hasSufficientMatingMaterial } from './clock.js';

const ROOM_ID_REGEX = /^[a-zA-Z0-9_-]{4,24}$/;
const PLAYER_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
const SQUARE_REGEX = /^[a-h][1-8]$/;
const VALID_PROMOTIONS = new Set(['q', 'r', 'b', 'n']);

const MAX_SPECTATORS_PER_ROOM = 20;
const MAX_CHAT_LENGTH = 200;
const MAX_CHAT_HISTORY = 60;
const EMPTY_ROOM_TTL_MS = 15 * 60 * 1000; // 15 phút không có ai kết nối
const IDLE_ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 giờ không có hoạt động

/** Escape các ký tự HTML đặc biệt để phòng chống XSS */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Chính sách xử lý khi một bên rớt mạng giữa ván đang chơi:
 * - 15 giây đầu (grace period): tạm dừng đồng hồ để reload F5 / chập chờn Wi-Fi không bị mất oan thời gian.
 * - Sau 15 giây: đồng hồ chạy lại bình thường và mở đếm ngược 60 giây bỏ cuộc (tổng 75 giây).
 * - Hết 75 giây vẫn chưa quay lại: xử thua do bỏ cuộc (abandonment).
 */
export const DISCONNECT_GRACE_MS = 15 * 1000;
export const DISCONNECT_FORFEIT_MS = 60 * 1000;

function generateRoomId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(8);
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += alphabet[bytes[i] % alphabet.length];
  }
  return id;
}

export function sanitizePlayerName(rawName, fallback) {
  if (typeof rawName !== 'string') return fallback;
  const cleaned = rawName.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 24);
  return cleaned || fallback;
}

export function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_REGEX.test(roomId);
}

export function isValidPlayerId(playerId) {
  return typeof playerId === 'string' && PLAYER_ID_REGEX.test(playerId);
}

export class RoomManager {
  /**
   * @param {{
   *   onClockUpdate?: (room: object) => void,
   *   onGameEnded?: (room: object) => void,
   *   onNotice?: (room: object, message: string) => void,
   * }} callbacks
   */
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    /** @type {Map<string, object>} roomId -> room */
    this.rooms = new Map();
    /** @type {Map<string, { roomId: string, role: 'w' | 'b' | 'spectator', playerId: string }>} */
    this.socketIndex = new Map();
  }

  /** Tạo phòng mới với chế độ thời gian tùy chọn */
  createRoom(options = {}) {
    let roomId = generateRoomId();
    while (this.rooms.has(roomId)) {
      roomId = generateRoomId();
    }

    const tcConfig = resolveTimeControl(options.timeControlId);
    const now = Date.now();

    const room = {
      id: roomId,
      createdAt: now,
      lastActivityAt: now,
      emptySince: now,
      chess: new Chess(),
      status: 'waiting', // 'waiting' | 'playing' | 'finished'
      result: null, // { winner: 'w' | 'b' | null, reason: string }
      lastMove: null,
      drawOffer: null, // null | { by: 'w' | 'b' }
      players: {
        w: null, // { playerId, name, socketId, connected, disconnectedAt, forfeitAt }
        b: null,
      },
      /** @type {Map<string, { playerId: string, name: string }>} */
      spectators: new Map(),
      /** Lịch sử chat trong phòng (tối đa MAX_CHAT_HISTORY tin gần nhất) */
      chatMessages: [],
      rematchVotes: new Set(),
      clock: null,
      disconnectTimers: {
        w: { grace: null, forfeit: null },
        b: { grace: null, forfeit: null },
      },
    };

    room.clock = new ChessClock(tcConfig, (flaggedColor) => {
      this._handleClockTimeout(room, flaggedColor);
    });

    this.rooms.set(roomId, room);
    return room;
  }

  getRoom(roomId) {
    if (!isValidRoomId(roomId)) return null;
    return this.rooms.get(roomId) || null;
  }

  _countConnected(room) {
    let count = room.spectators.size;
    if (room.players.w?.connected) count += 1;
    if (room.players.b?.connected) count += 1;
    return count;
  }

  /** Hủy timer grace/forfeit của một ghế ('w' hoặc 'b') */
  _clearDisconnectTimers(room, color) {
    const bucket = room.disconnectTimers[color];
    if (!bucket) return;
    if (bucket.grace) {
      clearTimeout(bucket.grace);
      bucket.grace = null;
    }
    if (bucket.forfeit) {
      clearTimeout(bucket.forfeit);
      bucket.forfeit = null;
    }
    if (room.players[color]) {
      room.players[color].forfeitAt = null;
    }
  }

  _clearAllDisconnectTimers(room) {
    this._clearDisconnectTimers(room, 'w');
    this._clearDisconnectTimers(room, 'b');
  }

  /** Kết thúc ván cờ sạch sẽ: dừng đồng hồ, dọn timer rớt mạng và xóa đề nghị hòa */
  _finishGame(room, result) {
    if (room.status === 'finished') return false;
    room.status = 'finished';
    room.result = result;
    room.drawOffer = null;
    room.rematchVotes.clear();
    room.clock.stop();
    this._clearAllDisconnectTimers(room);
    room.lastActivityAt = Date.now();
    return true;
  }

  /** Xử lý khi đồng hồ trên server báo một bên hết giờ */
  _handleClockTimeout(room, flaggedColor) {
    if (room.status !== 'playing') return;
    const opponent = flaggedColor === 'w' ? 'b' : 'w';
    const opponentCanMate = hasSufficientMatingMaterial(room.chess, opponent);

    const result = opponentCanMate
      ? { winner: opponent, reason: 'timeout' }
      : { winner: null, reason: 'timeout-insufficient' };

    if (this._finishGame(room, result)) {
      this.callbacks.onGameEnded?.(room);
    }
  }

  /** Bắt đầu chu trình grace period 15s -> forfeit 60s khi 1 bên rớt mạng lúc đang đấu */
  _startDisconnectCountdown(room, color) {
    if (room.status !== 'playing') return;
    const seat = room.players[color];
    if (!seat || seat.connected) return;

    this._clearDisconnectTimers(room, color);
    const opponent = color === 'w' ? 'b' : 'w';
    const label = color === 'w' ? 'Quân Trắng' : 'Quân Đen';

    // Bước 1: Tạm dừng đồng hồ trong 15 giây đầu (grace period)
    if (room.clock.pause('disconnect')) {
      this.callbacks.onClockUpdate?.(room);
    }

    seat.forfeitAt = Date.now() + DISCONNECT_GRACE_MS + DISCONNECT_FORFEIT_MS;

    const bucket = room.disconnectTimers[color];
    bucket.grace = setTimeout(() => {
      bucket.grace = null;
      if (room.status !== 'playing' || !room.players[color] || room.players[color].connected) {
        return;
      }

      // Chỉ tiếp tục chạy đồng hồ nếu phía đối thủ vẫn đang trực tuyến
      if (room.players[opponent]?.connected) {
        if (room.clock.resume()) {
          this.callbacks.onClockUpdate?.(room);
        }
        this.callbacks.onNotice?.(
          room,
          `${label} vẫn chưa kết nối lại — đồng hồ đã chạy tiếp (xử thua sau 60 giây nếu không quay lại).`
        );
      }

      // Bước 2: Đếm ngược 60 giây xử thua do bỏ cuộc
      bucket.forfeit = setTimeout(() => {
        bucket.forfeit = null;
        if (room.status !== 'playing' || !room.players[color] || room.players[color].connected) {
          return;
        }
        // Nếu đối thủ cũng rớt mạng luôn thì không xử đơn phương
        if (!room.players[opponent]?.connected) {
          return;
        }

        if (this._finishGame(room, { winner: opponent, reason: 'abandonment' })) {
          this.callbacks.onGameEnded?.(room);
        }
      }, DISCONNECT_FORFEIT_MS);

      if (typeof bucket.forfeit.unref === 'function') {
        bucket.forfeit.unref();
      }
    }, DISCONNECT_GRACE_MS);

    if (typeof bucket.grace.unref === 'function') {
      bucket.grace.unref();
    }
  }

  /** Tạo dữ liệu snapshot an toàn gửi xuống client */
  getPublicState(room, role = 'spectator') {
    const formatPlayer = (p) =>
      p
        ? {
            name: p.name,
            connected: p.connected,
            disconnectedAt: p.disconnectedAt,
            forfeitAt: p.forfeitAt || null,
          }
        : null;

    return {
      roomId: room.id,
      role,
      fen: room.chess.fen(),
      turn: room.chess.turn(),
      inCheck: room.chess.inCheck(),
      history: room.chess.history(),
      lastMove: room.lastMove,
      status: room.status,
      result: room.result,
      drawOffer: room.drawOffer,
      clock: room.clock.getSnapshot(),
      players: {
        w: formatPlayer(room.players.w),
        b: formatPlayer(room.players.b),
      },
      spectatorCount: room.spectators.size,
      chatMessages: room.chatMessages,
      rematchVotes: [...room.rematchVotes],
    };
  }

  /** Người chơi hoặc khán giả tham gia phòng */
  joinRoom({ roomId, playerId, playerName, socketId }) {
    if (!isValidRoomId(roomId)) {
      return { ok: false, code: 'INVALID_ROOM_ID', error: 'Mã phòng không hợp lệ.' };
    }
    if (!isValidPlayerId(playerId)) {
      return { ok: false, code: 'INVALID_PLAYER_ID', error: 'Định danh người chơi không hợp lệ.' };
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      return {
        ok: false,
        code: 'ROOM_NOT_FOUND',
        error: 'Phòng không tồn tại hoặc đã bị đóng do không hoạt động.',
      };
    }

    if (this.socketIndex.has(socketId)) {
      this.leaveBySocket(socketId);
    }

    room.lastActivityAt = Date.now();
    room.emptySince = null;

    let role = null;
    let reconnected = false;
    let replacedSocketId = null;

    // 1. Reconnect về đúng ghế cũ nhờ playerId
    for (const color of ['w', 'b']) {
      const seat = room.players[color];
      if (seat && seat.playerId === playerId) {
        if (seat.socketId && seat.socketId !== socketId) {
          replacedSocketId = seat.socketId;
          this.socketIndex.delete(seat.socketId);
        }
        seat.socketId = socketId;
        seat.connected = true;
        seat.disconnectedAt = null;
        this._clearDisconnectTimers(room, color);
        if (playerName) {
          seat.name = sanitizePlayerName(playerName, seat.name);
        }
        role = color;
        reconnected = true;

        // Nếu cả 2 người chơi đều đã trực tuyến lại -> tiếp tục chạy đồng hồ nếu đang tạm dừng
        if (room.status === 'playing' && room.players.w?.connected && room.players.b?.connected) {
          if (room.clock.resume()) {
            this.callbacks.onClockUpdate?.(room);
          }
        }
        break;
      }
    }

    // 2. Ghế Trắng trống
    if (!role && !room.players.w) {
      room.players.w = {
        playerId,
        name: sanitizePlayerName(playerName, 'Người chơi Trắng'),
        socketId,
        connected: true,
        disconnectedAt: null,
        forfeitAt: null,
      };
      role = 'w';
    }

    // 3. Ghế Đen trống -> đủ 2 người chơi, bắt đầu ván và chạy đồng hồ!
    if (!role && !room.players.b) {
      room.players.b = {
        playerId,
        name: sanitizePlayerName(playerName, 'Người chơi Đen'),
        socketId,
        connected: true,
        disconnectedAt: null,
        forfeitAt: null,
      };
      role = 'b';
      if (room.status === 'waiting') {
        room.status = 'playing';
        room.clock.start(room.chess.turn());
        // Nếu bên Trắng vừa rớt mạng đúng lúc Đen vào thì tạm dừng theo chính sách
        if (!room.players.w?.connected) {
          this._startDisconnectCountdown(room, 'w');
        }
      }
    }

    // 4. Đủ 2 người chơi -> Khán giả
    if (!role) {
      if (room.spectators.size >= MAX_SPECTATORS_PER_ROOM) {
        return {
          ok: false,
          code: 'ROOM_FULL',
          error: `Phòng đã đầy (tối đa 2 người chơi và ${MAX_SPECTATORS_PER_ROOM} khán giả).`,
        };
      }
      room.spectators.set(socketId, {
        playerId,
        name: sanitizePlayerName(playerName, 'Khán giả'),
      });
      role = 'spectator';
    }

    this.socketIndex.set(socketId, { roomId, role, playerId });

    return {
      ok: true,
      room,
      role,
      reconnected,
      replacedSocketId,
      state: this.getPublicState(room, role),
    };
  }

  /** Xử lý khi socket ngắt kết nối */
  leaveBySocket(socketId) {
    const info = this.socketIndex.get(socketId);
    if (!info) return null;
    this.socketIndex.delete(socketId);

    const room = this.rooms.get(info.roomId);
    if (!room) return null;

    if (info.role === 'w' || info.role === 'b') {
      const seat = room.players[info.role];
      if (seat && seat.socketId === socketId) {
        seat.connected = false;
        seat.disconnectedAt = Date.now();
        if (room.status === 'playing') {
          this._startDisconnectCountdown(room, info.role);
        }
      }
    } else {
      room.spectators.delete(socketId);
    }

    if (this._countConnected(room) === 0) {
      room.emptySince = Date.now();
    }

    return { room, role: info.role };
  }

  _evaluateGameOver(chess) {
    if (!chess.isGameOver()) return null;

    if (chess.isCheckmate()) {
      const winner = chess.turn() === 'w' ? 'b' : 'w';
      return { winner, reason: 'checkmate' };
    }
    if (chess.isStalemate()) {
      return { winner: null, reason: 'stalemate' };
    }
    if (chess.isInsufficientMaterial()) {
      return { winner: null, reason: 'insufficient' };
    }
    if (chess.isThreefoldRepetition()) {
      return { winner: null, reason: 'threefold' };
    }
    return { winner: null, reason: 'fifty-move' };
  }

  /** Kiểm tra và thực thi nước đi authoritative + cập nhật đồng hồ */
  applyMove({ socketId, from, to, promotion }) {
    const info = this.socketIndex.get(socketId);
    if (!info) return { ok: false, error: 'Bạn chưa tham gia phòng nào.' };

    const room = this.rooms.get(info.roomId);
    if (!room) return { ok: false, error: 'Phòng không tồn tại.' };

    if (info.role !== 'w' && info.role !== 'b') {
      return { ok: false, error: 'Khán giả chỉ có thể xem, không được đi cờ.', fen: room.chess.fen() };
    }
    if (room.status === 'waiting') {
      return { ok: false, error: 'Đang chờ đối thủ vào phòng.', fen: room.chess.fen() };
    }
    if (room.status !== 'playing') {
      return { ok: false, error: 'Ván cờ đã kết thúc.', fen: room.chess.fen() };
    }
    if (room.chess.turn() !== info.role) {
      return { ok: false, error: 'Chưa đến lượt của bạn.', fen: room.chess.fen() };
    }

    if (typeof from !== 'string' || !SQUARE_REGEX.test(from) || typeof to !== 'string' || !SQUARE_REGEX.test(to)) {
      return { ok: false, error: 'Tọa độ ô cờ không hợp lệ.', fen: room.chess.fen() };
    }

    let cleanPromotion;
    if (promotion !== undefined && promotion !== null && promotion !== '') {
      if (typeof promotion !== 'string' || !VALID_PROMOTIONS.has(promotion)) {
        return { ok: false, error: 'Quân phong cấp không hợp lệ.', fen: room.chess.fen() };
      }
      cleanPromotion = promotion;
    }

    // Kiểm tra xem bên đi đã hết giờ đúng lúc gửi nước hay chưa
    const snapBefore = room.clock.getSnapshot();
    const myRemaining = info.role === 'w' ? snapBefore.wMs : snapBefore.bMs;
    if (!snapBefore.unlimited && snapBefore.running && myRemaining <= 0) {
      this._handleClockTimeout(room, info.role);
      return { ok: false, error: 'Bạn đã hết thời gian!', fen: room.chess.fen() };
    }

    let move;
    try {
      move = room.chess.move({ from, to, promotion: cleanPromotion });
    } catch {
      return { ok: false, error: 'Nước đi không hợp lệ theo luật cờ.', fen: room.chess.fen() };
    }

    if (!move) {
      return { ok: false, error: 'Nước đi không hợp lệ theo luật cờ.', fen: room.chess.fen() };
    }

    // Cập nhật đồng hồ (trừ giờ đã dùng, cộng increment, chuyển lượt)
    const clockOutcome = room.clock.onMoveCompleted(info.role);
    if (clockOutcome.timedOut) {
      // Hoàn tác nước đi nếu vừa chạm mốc 0ms
      room.chess.undo();
      this._handleClockTimeout(room, info.role);
      return { ok: false, error: 'Bạn đã hết thời gian!', fen: room.chess.fen() };
    }

    // Đi nước mới sẽ tự động hủy lời đề nghị hòa cũ (nếu có)
    room.drawOffer = null;
    room.lastActivityAt = Date.now();
    room.lastMove = {
      from: move.from,
      to: move.to,
      san: move.san,
      captured: move.captured || null,
      flags: move.flags,
      color: move.color,
      piece: move.piece,
      promotion: move.promotion || null,
    };

    const gameOverResult = this._evaluateGameOver(room.chess);
    if (gameOverResult) {
      this._finishGame(room, gameOverResult);
    }

    return {
      ok: true,
      room,
      move: room.lastMove,
    };
  }

  /** Đầu hàng */
  resign(socketId) {
    const info = this.socketIndex.get(socketId);
    if (!info) return { ok: false, error: 'Bạn chưa tham gia phòng nào.' };

    const room = this.rooms.get(info.roomId);
    if (!room) return { ok: false, error: 'Phòng không tồn tại.' };

    if (info.role !== 'w' && info.role !== 'b') {
      return { ok: false, error: 'Chỉ người chơi mới có thể đầu hàng.' };
    }
    if (room.status !== 'playing') {
      return { ok: false, error: 'Ván cờ không trong trạng thái đang chơi.' };
    }

    const winner = info.role === 'w' ? 'b' : 'w';
    this._finishGame(room, { winner, reason: 'resign' });
    return { ok: true, room, resignedBy: info.role };
  }

  /** Gửi lời đề nghị hòa tới đối thủ */
  offerDraw(socketId) {
    const info = this.socketIndex.get(socketId);
    if (!info) return { ok: false, error: 'Bạn chưa tham gia phòng nào.' };

    const room = this.rooms.get(info.roomId);
    if (!room) return { ok: false, error: 'Phòng không tồn tại.' };

    if (info.role !== 'w' && info.role !== 'b') {
      return { ok: false, error: 'Chỉ người chơi mới có thể xin hòa.' };
    }
    if (room.status !== 'playing') {
      return { ok: false, error: 'Chỉ có thể xin hòa khi ván cờ đang diễn ra.' };
    }
    if (room.drawOffer) {
      if (room.drawOffer.by === info.role) {
        return { ok: false, error: 'Bạn đã gửi lời đề nghị hòa, vui lòng chờ đối thủ phản hồi.' };
      }
      // Đối thủ cũng đang xin hòa -> xem như đồng ý hòa ngay!
      this._finishGame(room, { winner: null, reason: 'agreement' });
      return { ok: true, room, acceptedImmediately: true };
    }

    room.drawOffer = { by: info.role };
    room.lastActivityAt = Date.now();
    return { ok: true, room, acceptedImmediately: false, offeredBy: info.role };
  }

  /** Đối thủ chấp nhận hoặc từ chối lời đề nghị hòa */
  respondDraw(socketId, accept) {
    const info = this.socketIndex.get(socketId);
    if (!info) return { ok: false, error: 'Bạn chưa tham gia phòng nào.' };

    const room = this.rooms.get(info.roomId);
    if (!room) return { ok: false, error: 'Phòng không tồn tại.' };

    if (info.role !== 'w' && info.role !== 'b') {
      return { ok: false, error: 'Khán giả không thể phản hồi lời đề nghị hòa.' };
    }
    if (room.status !== 'playing' || !room.drawOffer) {
      return { ok: false, error: 'Hiện không có lời đề nghị hòa nào.' };
    }
    if (room.drawOffer.by === info.role) {
      return { ok: false, error: 'Bạn không thể tự phản hồi lời đề nghị hòa của chính mình.' };
    }

    room.lastActivityAt = Date.now();
    if (accept) {
      this._finishGame(room, { winner: null, reason: 'agreement' });
      return { ok: true, room, accepted: true };
    }

    room.drawOffer = null;
    return { ok: true, room, accepted: false, declinedBy: info.role };
  }

  /**
   * Thêm tin nhắn chat giữa 2 người chơi (chặn khán giả, giới hạn 200 ký tự, escape HTML chống XSS).
   */
  addChatMessage({ socketId, text }) {
    const info = this.socketIndex.get(socketId);
    if (!info) return { ok: false, error: 'Bạn chưa tham gia phòng nào.' };

    const room = this.rooms.get(info.roomId);
    if (!room) return { ok: false, error: 'Phòng không tồn tại.' };

    if (info.role !== 'w' && info.role !== 'b') {
      return { ok: false, error: 'Khán giả chỉ có thể xem, không thể gửi tin nhắn.' };
    }

    if (typeof text !== 'string') {
      return { ok: false, error: 'Nội dung tin nhắn không hợp lệ.' };
    }

    const cleaned = text.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    if (!cleaned) {
      return { ok: false, error: 'Tin nhắn không được để trống.' };
    }
    if (cleaned.length > MAX_CHAT_LENGTH) {
      return { ok: false, error: `Tin nhắn tối đa ${MAX_CHAT_LENGTH} ký tự.` };
    }

    const senderSeat = room.players[info.role];
    const senderName = senderSeat?.name || (info.role === 'w' ? 'Quân Trắng' : 'Quân Đen');

    const message = {
      id: `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      senderRole: info.role,
      senderName,
      text: cleaned,
      safeHtml: escapeHtml(cleaned),
      timestamp: Date.now(),
    };

    room.chatMessages.push(message);
    if (room.chatMessages.length > MAX_CHAT_HISTORY) {
      room.chatMessages.shift();
    }
    room.lastActivityAt = Date.now();

    return { ok: true, room, message };
  }

  /** Tái đấu sau khi hết ván (đổi màu Trắng <-> Đen và reset đồng hồ) */
  requestRematch(socketId) {
    const info = this.socketIndex.get(socketId);
    if (!info) return { ok: false, error: 'Bạn chưa tham gia phòng nào.' };

    const room = this.rooms.get(info.roomId);
    if (!room) return { ok: false, error: 'Phòng không tồn tại.' };

    if (info.role !== 'w' && info.role !== 'b') {
      return { ok: false, error: 'Chỉ người chơi mới có thể yêu cầu chơi lại.' };
    }
    if (room.status !== 'finished') {
      return { ok: false, error: 'Ván cờ chưa kết thúc.' };
    }
    if (!room.players.w || !room.players.b) {
      return { ok: false, error: 'Cần đủ 2 người chơi để bắt đầu ván mới.' };
    }

    room.rematchVotes.add(info.role);
    room.lastActivityAt = Date.now();

    if (room.rematchVotes.has('w') && room.rematchVotes.has('b')) {
      const oldW = room.players.w;
      const oldB = room.players.b;
      room.players.w = oldB;
      room.players.b = oldW;

      if (room.players.w.socketId && this.socketIndex.has(room.players.w.socketId)) {
        this.socketIndex.get(room.players.w.socketId).role = 'w';
      }
      if (room.players.b.socketId && this.socketIndex.has(room.players.b.socketId)) {
        this.socketIndex.get(room.players.b.socketId).role = 'b';
      }

      room.chess.reset();
      room.status = 'playing';
      room.result = null;
      room.lastMove = null;
      room.drawOffer = null;
      room.rematchVotes.clear();
      this._clearAllDisconnectTimers(room);
      room.clock.reset();
      room.clock.start('w');

      return { ok: true, room, started: true };
    }

    return { ok: true, room, started: false, voter: info.role };
  }

  /** Dọn phòng trống / không hoạt động định kỳ */
  cleanupInactiveRooms() {
    const now = Date.now();
    let removed = 0;

    for (const [roomId, room] of this.rooms.entries()) {
      const isEmptyExpired = room.emptySince !== null && now - room.emptySince > EMPTY_ROOM_TTL_MS;
      const isIdleExpired = now - room.lastActivityAt > IDLE_ROOM_TTL_MS;

      if (isEmptyExpired || isIdleExpired) {
        room.clock.dispose();
        this._clearAllDisconnectTimers(room);
        for (const [sid, meta] of this.socketIndex.entries()) {
          if (meta.roomId === roomId) {
            this.socketIndex.delete(sid);
          }
        }
        this.rooms.delete(roomId);
        removed += 1;
      }
    }

    return removed;
  }

  getSocketInfo(socketId) {
    return this.socketIndex.get(socketId) || null;
  }

  /** Dọn sạch toàn bộ đồng hồ & timer của tất cả phòng khi tắt máy chủ */
  disposeAll() {
    for (const room of this.rooms.values()) {
      room.clock.dispose();
      this._clearAllDisconnectTimers(room);
    }
    this.rooms.clear();
    this.socketIndex.clear();
  }
}
