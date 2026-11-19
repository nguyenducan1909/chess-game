/**
 * Tầng mạng phía client (Socket.IO):
 * - Sinh và lưu định danh `playerId` trong localStorage để reload / rớt mạng quay lại đúng ghế cũ
 * - Hỗ trợ chế độ tab thử nghiệm (sessionStorage) khi mở 2 tab thường trên cùng trình duyệt
 * - Tự động kết nối lại (reconnect) và đồng bộ trạng thái phòng với server
 */

import { io } from 'socket.io-client';

const STORAGE_PLAYER_ID_KEY = 'chess3d_player_id';
const STORAGE_PLAYER_NAME_KEY = 'chess3d_player_name';
const SESSION_OVERRIDE_ID_KEY = 'chess3d_session_player_id';

/** Sinh chuỗi định danh ngẫu nhiên an toàn (32 ký tự hex) */
function createRandomId() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Lấy hoặc tạo `playerId` cố định trong localStorage (ưu tiên session override nếu đang ở tab thử nghiệm) */
export function getOrCreatePlayerId() {
  const sessionOverride = sessionStorage.getItem(SESSION_OVERRIDE_ID_KEY);
  if (sessionOverride) return sessionOverride;

  let id = localStorage.getItem(STORAGE_PLAYER_ID_KEY);
  if (!id || id.length < 8) {
    id = createRandomId();
    localStorage.setItem(STORAGE_PLAYER_ID_KEY, id);
  }
  return id;
}

/** Tạo danh tính riêng cho tab hiện tại (dùng khi mở 2 tab thường cùng trình duyệt để test) */
export function createSessionPlayerId() {
  const id = createRandomId();
  sessionStorage.setItem(SESSION_OVERRIDE_ID_KEY, id);
  return id;
}

export function getSavedPlayerName() {
  return localStorage.getItem(STORAGE_PLAYER_NAME_KEY) || '';
}

export function savePlayerName(name) {
  const clean = String(name || '').trim().slice(0, 24);
  if (clean) {
    localStorage.setItem(STORAGE_PLAYER_NAME_KEY, clean);
  } else {
    localStorage.removeItem(STORAGE_PLAYER_NAME_KEY);
  }
  return clean;
}

/**
 * Tạo client kết nối Socket.IO cho một phòng cụ thể.
 */
export function createRoomNetwork(roomId, callbacks = {}) {
  const socket = io({
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 4000,
  });

  let disposed = false;

  function performJoin() {
    if (disposed) return;
    const playerId = getOrCreatePlayerId();
    const playerName = getSavedPlayerName();

    socket.emit('room:join', { roomId, playerId, playerName }, (res) => {
      if (disposed) return;
      if (!res || !res.ok) {
        callbacks.onJoinError?.(res || { code: 'UNKNOWN', error: 'Không thể tham gia phòng.' });
        return;
      }
      callbacks.onJoined?.(res.state, { reconnected: Boolean(res.reconnected) });
    });
  }

  socket.on('connect', () => {
    callbacks.onConnectionChange?.('connected');
    performJoin();
  });

  socket.on('disconnect', (reason) => {
    callbacks.onConnectionChange?.('disconnected', reason);
  });

  socket.on('connect_error', (err) => {
    callbacks.onConnectionChange?.('error', err?.message || 'Lỗi kết nối máy chủ');
  });

  socket.on('room:state', (state) => {
    callbacks.onRoomState?.(state);
  });

  socket.on('room:players', (payload) => {
    callbacks.onPlayersUpdate?.(payload);
  });

  socket.on('game:moved', (payload) => {
    callbacks.onMoved?.(payload);
  });

  socket.on('clock:sync', (payload) => {
    callbacks.onClockSync?.(payload);
  });

  socket.on('game:ended', (payload) => {
    callbacks.onGameEnded?.(payload);
  });

  socket.on('game:draw-offer', (payload) => {
    callbacks.onDrawOffer?.(payload);
  });

  socket.on('chat:message', (message) => {
    callbacks.onChatMessage?.(message);
  });

  socket.on('room:notice', (payload) => {
    callbacks.onNotice?.(payload?.message || '');
  });

  socket.on('room:replaced', (payload) => {
    callbacks.onReplaced?.(payload?.message || 'Phiên đã được mở ở tab khác.');
  });

  function connect() {
    callbacks.onConnectionChange?.('connecting');
    socket.connect();
  }

  /** Gửi yêu cầu nước đi lên server và nhận phản hồi xác nhận */
  function sendMove({ from, to, promotion }) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({ ok: false, error: 'Đang mất kết nối máy chủ.' });
        return;
      }
      socket.timeout(6000).emit('game:move', { from, to, promotion }, (err, res) => {
        if (err) {
          resolve({ ok: false, error: 'Máy chủ không phản hồi kịp thời.' });
          return;
        }
        resolve(res || { ok: false, error: 'Phản hồi không hợp lệ.' });
      });
    });
  }

  /** Gửi yêu cầu chơi lại ván mới */
  function requestRematch() {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({ ok: false, error: 'Đang mất kết nối máy chủ.' });
        return;
      }
      socket.timeout(5000).emit('game:rematch', {}, (err, res) => {
        if (err) {
          resolve({ ok: false, error: 'Không nhận được phản hồi.' });
          return;
        }
        resolve(res || { ok: false, error: 'Phản hồi không hợp lệ.' });
      });
    });
  }

  /** Gửi yêu cầu đầu hàng */
  function resign() {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({ ok: false, error: 'Đang mất kết nối máy chủ.' });
        return;
      }
      socket.timeout(5000).emit('game:resign', {}, (err, res) => {
        if (err) {
          resolve({ ok: false, error: 'Không nhận được phản hồi.' });
          return;
        }
        resolve(res || { ok: false, error: 'Phản hồi không hợp lệ.' });
      });
    });
  }

  /** Gửi lời đề nghị hòa tới đối thủ */
  function offerDraw() {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({ ok: false, error: 'Đang mất kết nối máy chủ.' });
        return;
      }
      socket.timeout(5000).emit('game:draw-offer', {}, (err, res) => {
        if (err) {
          resolve({ ok: false, error: 'Không nhận được phản hồi.' });
          return;
        }
        resolve(res || { ok: false, error: 'Phản hồi không hợp lệ.' });
      });
    });
  }

  /** Phản hồi lời đề nghị hòa (chấp nhận / từ chối) */
  function respondDraw(accept) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({ ok: false, error: 'Đang mất kết nối máy chủ.' });
        return;
      }
      socket.timeout(5000).emit('game:draw-respond', { accept: Boolean(accept) }, (err, res) => {
        if (err) {
          resolve({ ok: false, error: 'Không nhận được phản hồi.' });
          return;
        }
        resolve(res || { ok: false, error: 'Phản hồi không hợp lệ.' });
      });
    });
  }

  /** Gửi tin nhắn chat trong phòng */
  function sendChat(text) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({ ok: false, error: 'Đang mất kết nối máy chủ.' });
        return;
      }
      socket.timeout(5000).emit('chat:send', { text }, (err, res) => {
        if (err) {
          resolve({ ok: false, error: 'Không thể gửi tin nhắn.' });
          return;
        }
        resolve(res || { ok: false, error: 'Phản hồi không hợp lệ.' });
      });
    });
  }

  /** Tham gia lại phòng bằng danh tính tab mới (dùng khi test 2 tab trên cùng trình duyệt) */
  function rejoinAsNewTabIdentity() {
    createSessionPlayerId();
    if (socket.connected) {
      performJoin();
    } else {
      socket.connect();
    }
  }

  function dispose() {
    disposed = true;
    socket.removeAllListeners();
    socket.disconnect();
  }

  return {
    connect,
    sendMove,
    requestRematch,
    resign,
    offerDraw,
    respondDraw,
    sendChat,
    rejoinAsNewTabIdentity,
    dispose,
  };
}

