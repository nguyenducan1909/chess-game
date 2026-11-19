/**
 * Quản lý đồng hồ cờ vua phía server (Authoritative Clock):
 * - Server là nguồn thời gian duy nhất (không tin đồng hồ của client)
 * - Hỗ trợ các chế độ thời gian phổ biến (3+2, 5+0, 10+0, 15+10, Không giới hạn)
 * - Dùng setTimeout chính xác cho mốc hết giờ của bên đang đi (không poll liên tục)
 * - Kiểm tra luật đủ quân chiếu hết khi hết giờ (hết giờ nhưng đối thủ không đủ quân -> Hòa)
 */

export const TIME_CONTROLS = {
  '3+2': {
    id: '3+2',
    label: '3+2 (Chớp)',
    baseMs: 3 * 60 * 1000,
    incrementMs: 2 * 1000,
    unlimited: false,
  },
  '5+0': {
    id: '5+0',
    label: '5+0 (Chớp)',
    baseMs: 5 * 60 * 1000,
    incrementMs: 0,
    unlimited: false,
  },
  '10+0': {
    id: '10+0',
    label: '10+0 (Cờ nhanh)',
    baseMs: 10 * 60 * 1000,
    incrementMs: 0,
    unlimited: false,
  },
  '15+10': {
    id: '15+10',
    label: '15+10 (Cờ nhanh)',
    baseMs: 15 * 60 * 1000,
    incrementMs: 10 * 1000,
    unlimited: false,
  },
  unlimited: {
    id: 'unlimited',
    label: 'Không giới hạn',
    baseMs: 0,
    incrementMs: 0,
    unlimited: true,
  },
};

export const DEFAULT_TIME_CONTROL_ID = '10+0';

/** Chuẩn hóa mã chế độ đồng hồ từ query/input; nếu không hợp lệ sẽ dùng mặc định 10+0 */
export function resolveTimeControl(rawId) {
  if (typeof rawId === 'string') {
    // Lưu ý: dấu '+' trong query string có thể bị decode thành khoảng trắng ' '
    const normalized = rawId.trim().replace(/\s+/g, '+');
    if (Object.prototype.hasOwnProperty.call(TIME_CONTROLS, normalized)) {
      return TIME_CONTROLS[normalized];
    }
  }
  return TIME_CONTROLS[DEFAULT_TIME_CONTROL_ID];
}

/**
 * Kiểm tra xem bên `color` ('w' | 'b') có đủ quân để chiếu hết đối thủ khi đối thủ hết giờ hay không.
 * Quy ước chuẩn cờ vua online:
 * - Có Tốt, Xe hoặc Hậu -> ĐỦ quân chiếu hết.
 * - Có ít nhất 2 Mã, hoặc Mã + Tượng, hoặc 2 Tượng khác màu ô -> ĐỦ quân chiếu hết.
 * - Chỉ còn Vua (K), Vua + 1 Mã (K+N), hoặc Vua + các Tượng cùng màu ô (K+B) -> KHÔNG đủ quân -> Hòa.
 * @param {import('chess.js').Chess} chess
 * @param {'w' | 'b'} color
 */
export function hasSufficientMatingMaterial(chess, color) {
  const board = chess.board();
  let knights = 0;
  const bishopColors = new Set();

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      if (!cell || cell.color !== color) continue;

      if (cell.type === 'p' || cell.type === 'r' || cell.type === 'q') {
        return true;
      }
      if (cell.type === 'n') {
        knights += 1;
      } else if (cell.type === 'b') {
        // Màu ô (0 hoặc 1) xác định Tượng ô trắng hay ô đen
        bishopColors.add((r + c) % 2);
      }
    }
  }

  if (knights >= 2) return true;
  if (knights >= 1 && bishopColors.size >= 1) return true;
  if (bishopColors.size >= 2) return true;

  return false;
}

/**
 * Đồng hồ cờ cho một phòng đấu.
 */
export class ChessClock {
  /**
   * @param {object} config Một mục trong TIME_CONTROLS
   * @param {(flaggedColor: 'w' | 'b') => void} onTimeout Callback khi một bên cạn giờ
   */
  constructor(config, onTimeout) {
    this.config = config || TIME_CONTROLS[DEFAULT_TIME_CONTROL_ID];
    this.onTimeout = onTimeout;

    this.wMs = this.config.baseMs;
    this.bMs = this.config.baseMs;
    this.activeColor = 'w';
    this.running = false;
    this.paused = false;
    this.pauseReason = null; // null | 'disconnect'
    this.lastTickAt = null;
    this._timeoutHandle = null;
  }

  /** Hủy timer nội bộ nếu đang chạy */
  _clearTimer() {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  /** Cập nhật số mili-giây đã trôi qua cho bên đang active */
  _syncElapsed(now = Date.now()) {
    if (this.config.unlimited || !this.running || this.paused || this.lastTickAt === null) {
      return;
    }
    const elapsed = Math.max(0, now - this.lastTickAt);
    if (this.activeColor === 'w') {
      this.wMs = Math.max(0, this.wMs - elapsed);
    } else {
      this.bMs = Math.max(0, this.bMs - elapsed);
    }
    this.lastTickAt = now;
  }

  /** Đặt hẹn giờ đúng tới khoảnh khắc bên đang đi hết thời gian */
  _scheduleTimeout() {
    this._clearTimer();
    if (this.config.unlimited || !this.running || this.paused) return;

    const remaining = this.activeColor === 'w' ? this.wMs : this.bMs;
    if (remaining <= 0) {
      const flagged = this.activeColor;
      this.stop();
      this.onTimeout?.(flagged);
      return;
    }

    this._timeoutHandle = setTimeout(() => {
      this._timeoutHandle = null;
      this._syncElapsed();
      const rem = this.activeColor === 'w' ? this.wMs : this.bMs;
      if (rem <= 5) {
        if (this.activeColor === 'w') this.wMs = 0;
        else this.bMs = 0;
        const flagged = this.activeColor;
        this.stop();
        this.onTimeout?.(flagged);
      } else {
        // Trường hợp hiếm timer JS nổ sớm vài ms -> hẹn lại phần còn lại
        this._scheduleTimeout();
      }
    }, remaining + 10);

    if (typeof this._timeoutHandle.unref === 'function') {
      this._timeoutHandle.unref();
    }
  }

  /** Bắt đầu chạy đồng hồ cho lượt `activeColor` */
  start(activeColor = 'w') {
    this.activeColor = activeColor;
    this.running = true;
    this.paused = false;
    this.pauseReason = null;
    this.lastTickAt = Date.now();
    this._scheduleTimeout();
  }

  /**
   * Ghi nhận bên `moverColor` vừa đi xong một nước hợp lệ:
   * - Trừ thời gian đã dùng
   * - Nếu đã hết giờ trước đó -> trả về { timedOut: true, flaggedColor }
   * - Nếu còn giờ -> cộng increment, chuyển lượt đồng hồ sang đối thủ
   */
  onMoveCompleted(moverColor) {
    if (this.config.unlimited) {
      this.activeColor = moverColor === 'w' ? 'b' : 'w';
      return { timedOut: false };
    }

    const now = Date.now();
    this._syncElapsed(now);

    const remaining = moverColor === 'w' ? this.wMs : this.bMs;
    if (this.running && remaining <= 0) {
      this.stop();
      return { timedOut: true, flaggedColor: moverColor };
    }

    // Cộng thời gian tăng thêm (increment) sau khi đi xong nước cờ
    if (this.config.incrementMs > 0) {
      if (moverColor === 'w') this.wMs += this.config.incrementMs;
      else this.bMs += this.config.incrementMs;
    }

    this.activeColor = moverColor === 'w' ? 'b' : 'w';
    this.lastTickAt = now;
    if (this.running && !this.paused) {
      this._scheduleTimeout();
    }
    return { timedOut: false };
  }

  /** Tạm dừng đồng hồ (vd: trong thời gian grace period khi đối thủ mới rớt mạng) */
  pause(reason = 'disconnect') {
    if (!this.running || this.paused) return false;
    this._syncElapsed();
    this._clearTimer();
    this.paused = true;
    this.pauseReason = reason;
    this.lastTickAt = null;
    return true;
  }

  /** Tiếp tục chạy đồng hồ sau khi tạm dừng */
  resume() {
    if (!this.running || !this.paused) return false;
    this.paused = false;
    this.pauseReason = null;
    this.lastTickAt = Date.now();
    this._scheduleTimeout();
    return true;
  }

  /** Dừng hẳn đồng hồ (khi ván kết thúc) */
  stop() {
    this._syncElapsed();
    this._clearTimer();
    this.running = false;
    this.paused = false;
    this.pauseReason = null;
    this.lastTickAt = null;
  }

  /** Đặt lại toàn bộ thời gian về ban đầu (khi tái đấu) */
  reset() {
    this._clearTimer();
    this.wMs = this.config.baseMs;
    this.bMs = this.config.baseMs;
    this.activeColor = 'w';
    this.running = false;
    this.paused = false;
    this.pauseReason = null;
    this.lastTickAt = null;
  }

  /** Lấy snapshot an toàn tại thời điểm hiện tại để gửi xuống client nội suy */
  getSnapshot() {
    const now = Date.now();
    let wMs = this.wMs;
    let bMs = this.bMs;

    if (!this.config.unlimited && this.running && !this.paused && this.lastTickAt !== null) {
      const elapsed = Math.max(0, now - this.lastTickAt);
      if (this.activeColor === 'w') wMs = Math.max(0, wMs - elapsed);
      else bMs = Math.max(0, bMs - elapsed);
    }

    return {
      presetId: this.config.id,
      label: this.config.label,
      unlimited: this.config.unlimited,
      incrementMs: this.config.incrementMs,
      wMs,
      bMs,
      activeColor: this.activeColor,
      running: this.running,
      paused: this.paused,
      pauseReason: this.pauseReason,
      serverNow: now,
    };
  }

  dispose() {
    this._clearTimer();
  }
}

