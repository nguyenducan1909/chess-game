/**
 * Bộ tạo âm thanh bằng Web Audio API (không cần file âm thanh ngoài):
 * - Chỉ khởi tạo AudioContext sau lần tương tác đầu tiên của người dùng (pointerdown / keydown)
 * - Gồm các âm thanh: đi quân, bắt quân, nhập thành, chiếu, kết thúc ván, tin nhắn chat, nước đi lỗi
 * - Hỗ trợ bật/tắt âm và lưu tùy chọn trong localStorage
 */

const STORAGE_MUTE_KEY = 'chess3d_audio_muted';

export class ChessAudio {
  constructor() {
    /** @type {AudioContext | null} */
    this.ctx = null;
    this.noiseBuffer = null;
    this.muted = localStorage.getItem(STORAGE_MUTE_KEY) === '1';
    this._unlocked = false;

    // Gắn listener một lần để khởi tạo AudioContext đúng chuẩn trình duyệt sau lần chạm/phím đầu tiên
    this._onFirstGesture = () => {
      this._ensureContext();
      if (this._unlocked) {
        window.removeEventListener('pointerdown', this._onFirstGesture);
        window.removeEventListener('keydown', this._onFirstGesture);
      }
    };
    window.addEventListener('pointerdown', this._onFirstGesture, { passive: true });
    window.addEventListener('keydown', this._onFirstGesture, { passive: true });
  }

  isMuted() {
    return this.muted;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    localStorage.setItem(STORAGE_MUTE_KEY, this.muted ? '1' : '0');
    return this.muted;
  }

  toggleMute() {
    const next = this.setMuted(!this.muted);
    if (!next) {
      this._ensureContext();
    }
    return next;
  }

  /** Chỉ tạo AudioContext khi đã có tương tác người dùng */
  _ensureContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;

    if (!this.ctx) {
      this.ctx = new AudioCtx();
      this.noiseBuffer = this._createNoiseBuffer(this.ctx);
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    this._unlocked = true;
    return this.ctx;
  }

  /** Tạo buffer nhiễu trắng ngắn dùng để tổng hợp tiếng va chạm gỗ của quân cờ */
  _createNoiseBuffer(ctx) {
    const length = Math.floor(ctx.sampleRate * 0.12);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.02));
    }
    return buffer;
  }

  /** Helper phát một nốt đơn có envelope mượt */
  _playTone(ctx, { type = 'sine', freqStart, freqEnd, startOffset = 0, duration = 0.12, gain = 0.16 }) {
    const now = ctx.currentTime + startOffset;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    if (freqEnd && freqEnd !== freqStart) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + duration);
    }

    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /** Helper phát xung gõ gỗ (noise qua bộ lọc bandpass) */
  _playWoodClick(ctx, { startOffset = 0, filterFreq = 900, q = 2.2, gain = 0.22, duration = 0.065 }) {
    if (!this.noiseBuffer) return;
    const now = ctx.currentTime + startOffset;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(filterFreq, now);
    filter.Q.setValueAtTime(q, now);

    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    src.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    src.start(now);
    src.stop(now + duration + 0.01);
  }

  _getReadyContext() {
    if (this.muted || !this._unlocked) return null;
    if (!this.ctx) return null;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /** Tiếng đi quân thường: tiếng đặt quân gỗ trầm gọn */
  playMove() {
    const ctx = this._getReadyContext();
    if (!ctx) return;
    this._playWoodClick(ctx, { filterFreq: 850, q: 2.0, gain: 0.24, duration: 0.06 });
    this._playTone(ctx, { type: 'triangle', freqStart: 190, freqEnd: 95, duration: 0.075, gain: 0.18 });
  }

  /** Tiếng bắt quân: tiếng va chạm mạnh và sắc hơn */
  playCapture() {
    const ctx = this._getReadyContext();
    if (!ctx) return;
    this._playWoodClick(ctx, { filterFreq: 1350, q: 1.5, gain: 0.34, duration: 0.085 });
    this._playTone(ctx, { type: 'triangle', freqStart: 250, freqEnd: 82, duration: 0.11, gain: 0.24 });
    this._playTone(ctx, { type: 'sine', freqStart: 120, freqEnd: 58, startOffset: 0.02, duration: 0.1, gain: 0.16 });
  }

  /** Tiếng nhập thành: hai nhịp đặt Vua và Xe nối tiếp nhau */
  playCastle() {
    const ctx = this._getReadyContext();
    if (!ctx) return;
    this._playWoodClick(ctx, { startOffset: 0, filterFreq: 880, gain: 0.24, duration: 0.06 });
    this._playTone(ctx, { type: 'triangle', freqStart: 195, freqEnd: 100, startOffset: 0, duration: 0.075, gain: 0.17 });

    this._playWoodClick(ctx, { startOffset: 0.12, filterFreq: 1050, gain: 0.26, duration: 0.065 });
    this._playTone(ctx, { type: 'triangle', freqStart: 225, freqEnd: 115, startOffset: 0.12, duration: 0.08, gain: 0.19 });
  }

  /** Tiếng chiếu: tín hiệu 2 nốt dứt khoát */
  playCheck() {
    const ctx = this._getReadyContext();
    if (!ctx) return;
    this._playTone(ctx, { type: 'triangle', freqStart: 660, freqEnd: 650, startOffset: 0.03, duration: 0.13, gain: 0.15 });
    this._playTone(ctx, { type: 'triangle', freqStart: 880, freqEnd: 860, startOffset: 0.13, duration: 0.18, gain: 0.16 });
  }

  /** Tiếng kết thúc ván ('win' | 'loss' | 'draw') */
  playGameOver(outcome = 'draw') {
    const ctx = this._getReadyContext();
    if (!ctx) return;

    if (outcome === 'win') {
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
      notes.forEach((f, idx) => {
        this._playTone(ctx, {
          type: 'triangle',
          freqStart: f,
          startOffset: idx * 0.11,
          duration: idx === notes.length - 1 ? 0.42 : 0.18,
          gain: 0.15,
        });
      });
    } else if (outcome === 'loss') {
      const notes = [392.0, 349.23, 311.13, 261.63]; // G4 F4 Eb4 C4
      notes.forEach((f, idx) => {
        this._playTone(ctx, {
          type: 'triangle',
          freqStart: f,
          startOffset: idx * 0.13,
          duration: idx === notes.length - 1 ? 0.45 : 0.2,
          gain: 0.14,
        });
      });
    } else {
      // Hòa
      this._playTone(ctx, { type: 'sine', freqStart: 440, startOffset: 0, duration: 0.22, gain: 0.13 });
      this._playTone(ctx, { type: 'sine', freqStart: 523.25, startOffset: 0.16, duration: 0.34, gain: 0.13 });
    }
  }

  /** Tiếng thông báo tin nhắn chat mới */
  playChat() {
    const ctx = this._getReadyContext();
    if (!ctx) return;
    this._playTone(ctx, { type: 'sine', freqStart: 880, freqEnd: 1174.66, duration: 0.11, gain: 0.08 });
  }

  /** Phản hồi nhẹ khi nước đi không hợp lệ */
  playInvalid() {
    const ctx = this._getReadyContext();
    if (!ctx) return;
    this._playTone(ctx, { type: 'sawtooth', freqStart: 155, freqEnd: 110, duration: 0.12, gain: 0.07 });
  }

  dispose() {
    window.removeEventListener('pointerdown', this._onFirstGesture);
    window.removeEventListener('keydown', this._onFirstGesture);
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

