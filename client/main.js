/**
 * Điểm khởi chạy client (Giai đoạn 4 - Online 2 người chơi với Socket.IO):
 * - Điều tuyến theo URL:
 *   + `/`         : Lobby tạo phòng (/new), nhập mã phòng, hoặc chơi cục bộ (/local)
 *   + `/room/:id` : Phòng đấu online realtime (Server authoritative, reconnect giữ ghế)
 *   + `/local`    : Chơi cục bộ 2 người trên cùng 1 máy
 * - Tải model chess_set.glb 1 lần khi vào bàn chơi, đồng bộ bàn 3D theo FEN chuẩn từ server
 */

import { Chess } from 'chess.js';
import { createChessScene } from './scene.js';
import { loadChessAssets, BoardPiecesManager, BoardHighlights } from './pieces.js';
import { ChessInputController } from './input.js';
import { createGameUI } from './ui.js';
import { createRoomNetwork, getSavedPlayerName, savePlayerName } from './net.js';
import { ChessAudio } from './audio.js';

const MODEL_URL = import.meta.env.VITE_MODEL_URL || '/models/chess_set_opt.glb';

// Xác định chế độ dựa trên đường dẫn URL
function parseRoute() {
  const pathname = window.location.pathname;
  const roomMatch = pathname.match(/^\/room\/([a-zA-Z0-9_-]{4,24})\/?$/);
  if (roomMatch) {
    return { mode: 'online', roomId: roomMatch[1] };
  }
  if (pathname === '/local' || pathname === '/local/') {
    return { mode: 'local', roomId: null };
  }
  return { mode: 'lobby', roomId: null };
}

const route = parseRoute();

// Các phần tử DOM chung
const canvas = document.getElementById('chess-canvas');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingTitle = document.getElementById('loading-title');
const loadingDetail = document.getElementById('loading-detail');
const loadingBar = document.getElementById('loading-bar');
const loadingPercent = document.getElementById('loading-percent');

const errorOverlay = document.getElementById('error-overlay');
const errorMessage = document.getElementById('error-message');
const btnRetry = document.getElementById('btn-retry');
const hudStatus = document.getElementById('hud-status');

// Trạng thái ván cờ cục bộ (chỉ dùng để tính nước hợp lệ ở client; online luôn đồng bộ theo FEN từ server)
const chess = new Chess();
const audio = new ChessAudio();

let chessScene = null;
let chessAssets = null;
let piecesManager = null;
let highlights = null;
let inputController = null;
let ui = null;
let roomNet = null;

let assetsReady = false;
let cameraSide = 'w';
let hasInitialCameraOriented = false;
let coordsVisible = true;
let isAwaitingPromotion = false;
let isSubmittingMove = false;

/** Trạng thái phòng online nhận từ server */
let onlineState = null;
/** Snapshot đồng hồ mới nhất từ server để nội suy hiển thị ở client */
let clockSyncState = null;
let clockIntervalId = null;

function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setLoadingState({ title, detail, percent }) {
  if (title) loadingTitle.textContent = title;
  if (detail) loadingDetail.textContent = detail;
  if (typeof percent === 'number') {
    const clamped = Math.max(0, Math.min(100, percent));
    loadingBar.style.width = `${clamped}%`;
    loadingPercent.textContent = `${clamped}%`;
  }
}

function showError(err) {
  console.error('Lỗi khởi chạy cảnh 3D:', err);
  loadingOverlay.classList.add('hidden');
  errorMessage.textContent =
    err instanceof Error ? err.message : String(err || 'Đã xảy ra lỗi không xác định.');
  errorOverlay.classList.remove('hidden');
  hudStatus.textContent = 'Lỗi tải cảnh 3D';
}

/** Tìm ô chứa Vua của màu `color` trên bàn hiện tại */
function findKingSquare(color) {
  const board = chess.board();
  const files = 'abcdefgh';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      if (cell && cell.type === 'k' && cell.color === color) {
        return `${files[c]}${8 - r}`;
      }
    }
  }
  return null;
}

/** Diễn giải lý do kết thúc ván từ kết quả server */
function formatResultText(result) {
  if (!result) return 'Ván cờ đã kết thúc';
  const winnerLabel = result.winner === 'w' ? 'Quân Trắng' : 'Quân Đen';
  const loserLabel = result.winner === 'w' ? 'Quân Đen' : 'Quân Trắng';
  switch (result.reason) {
    case 'checkmate':
      return `Chiếu hết! ${winnerLabel} chiến thắng`;
    case 'timeout':
      return `Hết giờ! ${winnerLabel} chiến thắng`;
    case 'timeout-insufficient':
      return 'Hòa cờ — Hết giờ nhưng đối thủ không đủ quân chiếu hết';
    case 'resign':
      return `${loserLabel} đầu hàng — ${winnerLabel} chiến thắng`;
    case 'agreement':
      return 'Hòa cờ — Hai bên thỏa thuận hòa';
    case 'abandonment':
      return `${loserLabel} rớt mạng quá lâu — ${winnerLabel} chiến thắng`;
    case 'stalemate':
      return 'Hòa cờ — Hết nước đi (Stalemate)';
    case 'insufficient':
      return 'Hòa cờ — Không đủ quân chiếu hết';
    case 'threefold':
      return 'Hòa cờ — Lặp lại thế cờ 3 lần';
    case 'fifty-move':
      return 'Hòa cờ — Luật 50 nước';
    default:
      return result.winner ? `${winnerLabel} chiến thắng` : 'Ván cờ kết thúc hòa';
  }
}

/** Ghi nhận mốc thời gian đồng hồ từ server và cập nhật giao diện ngay */
function syncClockFromServer(clockSnapshot) {
  if (!clockSnapshot) return;
  clockSyncState = {
    snapshot: clockSnapshot,
    receivedAt: performance.now(),
  };
  renderInterpolatedClock();
}

/** Nội suy hiển thị đồng hồ mượt trên client (chỉ để hiển thị, server vẫn quyết định hết giờ) */
function renderInterpolatedClock() {
  if (!ui || !clockSyncState) return;
  const snap = clockSyncState.snapshot;
  const elapsed =
    !snap.unlimited && snap.running && !snap.paused
      ? Math.max(0, performance.now() - clockSyncState.receivedAt)
      : 0;

  const wMs = snap.activeColor === 'w' ? Math.max(0, snap.wMs - elapsed) : snap.wMs;
  const bMs = snap.activeColor === 'b' ? Math.max(0, snap.bMs - elapsed) : snap.bMs;

  ui.renderClocks({
    ...snap,
    wMs,
    bMs,
  });
}

/** Tạo dòng trạng thái ván cờ phù hợp cho cả Online và Local */
function describeGameStatus() {
  const turnLabel = chess.turn() === 'w' ? 'Quân Trắng' : 'Quân Đen';

  if (route.mode === 'online') {
    if (!onlineState) {
      return { statusText: 'Đang kết nối vào phòng...', statusTone: 'waiting' };
    }
    if (onlineState.status === 'waiting') {
      return {
        statusText: 'Đang chờ đối thủ vào phòng... Hãy gửi link mời!',
        statusTone: 'waiting',
      };
    }
    if (onlineState.status === 'finished') {
      return {
        statusText: formatResultText(onlineState.result),
        statusTone: 'gameover',
      };
    }
    if (chess.inCheck()) {
      const isMyTurn = onlineState.role === chess.turn();
      return {
        statusText: isMyTurn ? 'Chiếu! Vua của bạn đang bị chiếu' : `Chiếu! ${turnLabel} đang bị chiếu`,
        statusTone: 'check',
      };
    }
    if (onlineState.role === 'spectator') {
      return { statusText: `Đang xem — Đến lượt ${turnLabel}`, statusTone: 'normal' };
    }
    const isMyTurn = onlineState.role === chess.turn();
    return {
      statusText: isMyTurn ? 'Đến lượt bạn đi!' : `Đang chờ ${turnLabel} đi...`,
      statusTone: 'normal',
    };
  }

  // Chế độ Local
  if (chess.isCheckmate()) {
    const winner = chess.turn() === 'w' ? 'Quân Đen' : 'Quân Trắng';
    return { statusText: `Chiếu hết! ${winner} chiến thắng`, statusTone: 'gameover' };
  }
  if (chess.isStalemate()) {
    return { statusText: 'Hòa cờ — Hết nước đi (Stalemate)', statusTone: 'gameover' };
  }
  if (chess.isInsufficientMaterial()) {
    return { statusText: 'Hòa cờ — Không đủ quân chiếu hết', statusTone: 'gameover' };
  }
  if (chess.isThreefoldRepetition()) {
    return { statusText: 'Hòa cờ — Lặp lại thế cờ 3 lần', statusTone: 'gameover' };
  }
  if (chess.isDraw()) {
    return { statusText: 'Hòa cờ — Luật 50 nước', statusTone: 'gameover' };
  }
  if (chess.inCheck()) {
    return { statusText: `Chiếu! ${turnLabel} đang bị chiếu`, statusTone: 'check' };
  }
  return { statusText: `Đang chơi — Đến lượt ${turnLabel}`, statusTone: 'normal' };
}

/** Phát âm thanh kết thúc ván theo vai trò người xem */
function playOutcomeAudio(result, myRole = null) {
  if (!result || !result.winner) {
    audio.playGameOver('draw');
    return;
  }
  if (myRole === 'w' || myRole === 'b') {
    audio.playGameOver(result.winner === myRole ? 'win' : 'loss');
  } else {
    audio.playGameOver('win');
  }
}

/** Phát âm thanh & kích hoạt hiệu ứng sóng chiếu/chiếu hết cho một nước đi vừa hoàn tất */
function triggerMoveFeedback({ move, inCheck, isFinished, result, myRole = null }) {
  const flags = move?.flags || '';
  if (flags.includes('k') || flags.includes('q')) {
    audio.playCastle();
  } else if (move?.captured || flags.includes('c') || flags.includes('e')) {
    audio.playCapture();
  } else {
    audio.playMove();
  }

  if (inCheck) {
    const kingSq = findKingSquare(chess.turn());
    const isMate = Boolean(isFinished && result?.reason === 'checkmate');
    highlights?.triggerCheckEffect(kingSq, isMate);
    if (!isFinished) {
      audio.playCheck();
    }
  }

  if (isFinished) {
    playOutcomeAudio(result, myRole);
  }
}

/** Đồng bộ toàn bộ 3D và UI theo trạng thái hiện tại */
function syncBoardAndUI({ animateMove = null } = {}) {
  if (!ui) return;

  if (assetsReady && piecesManager && highlights) {
    if (animateMove) {
      piecesManager.animateMove(animateMove, chess.fen());
    } else {
      piecesManager.syncFromFen(chess.fen());
    }

    // Highlight nước đi cuối cùng
    const lastMove =
      route.mode === 'online'
        ? onlineState?.lastMove || null
        : (() => {
            const hist = chess.history({ verbose: true });
            return hist[hist.length - 1] || null;
          })();

    if (lastMove) {
      highlights.setLastMove(lastMove.from, lastMove.to);
    } else {
      highlights.setLastMove(null, null);
    }

    // Highlight ô Vua đang bị chiếu
    if (chess.inCheck()) {
      highlights.setCheckSquare(findKingSquare(chess.turn()));
    } else {
      highlights.setCheckSquare(null);
    }

    // Kiểm soát quyền tương tác bàn cờ
    const canInteract =
      route.mode === 'local'
        ? !chess.isGameOver() && !isAwaitingPromotion
        : Boolean(
            onlineState &&
              onlineState.status === 'playing' &&
              (onlineState.role === 'w' || onlineState.role === 'b') &&
              !isAwaitingPromotion &&
              !isSubmittingMove
          );

    inputController?.setEnabled(canInteract);
  }

  const historySan =
    route.mode === 'online' ? onlineState?.history || [] : chess.history();

  const { statusText, statusTone } = describeGameStatus();
  ui.updateGameState({
    turn: chess.turn(),
    statusText,
    statusTone,
    historySan,
    board2D: chess.board(),
    canUndo: route.mode === 'local' && chess.history().length > 0 && !isAwaitingPromotion,
  });

  if (route.mode === 'online' && onlineState) {
    ui.updateOnlineRoomInfo({
      role: onlineState.role,
      players: onlineState.players,
      spectatorCount: onlineState.spectatorCount,
      status: onlineState.status,
      drawOffer: onlineState.drawOffer || null,
      rematchVotes: onlineState.rematchVotes,
    });
    if (onlineState.clock) {
      syncClockFromServer(onlineState.clock);
    }
  }
}

/** Xác định ô có quân được phép chọn ở thời điểm hiện tại hay không */
function canSelectSquare(square) {
  if (isAwaitingPromotion || isSubmittingMove) return false;

  if (route.mode === 'online') {
    if (!onlineState || onlineState.status !== 'playing') return false;
    if (onlineState.role !== 'w' && onlineState.role !== 'b') return false;
    if (chess.turn() !== onlineState.role) return false;
  } else if (chess.isGameOver()) {
    return false;
  }

  const piece = chess.get(square);
  if (!piece || piece.color !== chess.turn()) return false;
  return chess.moves({ square, verbose: true }).length > 0;
}

/** Lấy các ô đi hợp lệ từ ô đang chọn để tô sáng */
function getLegalMovesForSquare(square) {
  const verboseMoves = chess.moves({ square, verbose: true });
  const byTarget = new Map();

  for (const m of verboseMoves) {
    const isCapture = Boolean(m.captured || m.flags.includes('c') || m.flags.includes('e'));
    if (!byTarget.has(m.to)) {
      byTarget.set(m.to, { to: m.to, isCapture });
    }
  }
  return [...byTarget.values()];
}

/** Áp dụng toàn bộ snapshot phòng từ server (khi mới vào, reconnect, hoặc bắt đầu ván tái đấu) */
function applyServerRoomState(state, { orientCamera = false } = {}) {
  onlineState = { ...state };
  chess.load(state.fen);
  inputController?.clearSelection();

  if (orientCamera && chessScene) {
    const desiredSide = state.role === 'b' ? 'b' : 'w';
    cameraSide = desiredSide;
    chessScene.setCameraSide(desiredSide, !hasInitialCameraOriented);
    hasInitialCameraOriented = true;
  }

  ui?.setChatMessages(state.chatMessages || [], state.role);
  syncBoardAndUI();
}

/** Xử lý khi người chơi thực hiện nước đi `from -> to` */
async function handleAttemptMove(from, to) {
  if (isAwaitingPromotion || isSubmittingMove) return;

  const candidateMoves = chess
    .moves({ square: from, verbose: true })
    .filter((m) => m.to === to);

  if (candidateMoves.length === 0) {
    piecesManager?.shakePiece(from);
    audio.playInvalid();
    ui?.showToast('Nước đi không hợp lệ', 'warn');
    return;
  }

  let promotion;
  const needsPromotion = candidateMoves.some((m) => Boolean(m.promotion));
  if (needsPromotion) {
    isAwaitingPromotion = true;
    inputController?.setEnabled(false);
    const chosen = await ui.promptPromotion(chess.turn());
    isAwaitingPromotion = false;

    if (!chosen) {
      syncBoardAndUI();
      return;
    }
    promotion = chosen;
  }

  // --- Chế độ Online: gửi lên server kiểm tra (authoritative) ---
  if (route.mode === 'online') {
    if (!roomNet) return;
    isSubmittingMove = true;
    inputController?.setEnabled(false);

    const res = await roomNet.sendMove({ from, to, promotion });
    isSubmittingMove = false;

    if (!res.ok) {
      // Hoàn tác theo FEN chuẩn từ server và phản hồi nhẹ
      if (res.fen) {
        chess.load(res.fen);
      }
      inputController?.clearSelection();
      syncBoardAndUI();
      piecesManager?.shakePiece(from);
      audio.playInvalid();
      ui?.showToast(res.error || 'Nước đi bị từ chối bởi máy chủ', 'warn');
    }
    // Nếu ok: sự kiện `game:moved` từ server sẽ chạy animation, âm thanh & đồng bộ cả 2 bên
    return;
  }

  // --- Chế độ Local ---
  const move = chess.move({ from, to, promotion });
  if (!move) {
    piecesManager?.shakePiece(from);
    audio.playInvalid();
    ui?.showToast('Nước đi không hợp lệ', 'warn');
    return;
  }

  syncBoardAndUI({ animateMove: move });

  const isMate = chess.isCheckmate();
  const isFinished = chess.isGameOver();
  const localResult = isMate
    ? { winner: chess.turn() === 'w' ? 'b' : 'w', reason: 'checkmate' }
    : isFinished
      ? { winner: null, reason: 'draw' }
      : null;

  triggerMoveFeedback({
    move,
    inCheck: chess.inCheck(),
    isFinished,
    result: localResult,
  });

  if (isMate) {
    const winner = chess.turn() === 'w' ? 'Quân Đen' : 'Quân Trắng';
    ui.showToast(`Chiếu hết! ${winner} thắng!`, 'success');
  } else if (chess.isDraw()) {
    ui.showToast('Ván cờ kết thúc hòa!', 'info');
  } else if (chess.inCheck()) {
    ui.showToast('Chiếu!', 'warn');
  }
}

function handleNewGame() {
  if (route.mode !== 'local' || isAwaitingPromotion) return;
  chess.reset();
  inputController?.clearSelection();
  syncBoardAndUI();
  ui?.showToast('Đã bắt đầu ván mới', 'info');
}

function handleUndo() {
  if (route.mode !== 'local' || isAwaitingPromotion) return;
  const undone = chess.undo();
  if (!undone) return;
  inputController?.clearSelection();
  syncBoardAndUI();
}

async function handleRematch() {
  if (route.mode !== 'online' || !roomNet) return;
  const res = await roomNet.requestRematch();
  if (!res.ok) {
    ui?.showToast(res.error || 'Không thể yêu cầu chơi lại', 'warn');
    return;
  }
  if (!res.started) {
    ui?.showToast('Đã gửi lời mời chơi lại — đang chờ đối thủ...', 'info');
  }
}

function handleResignClick() {
  if (route.mode !== 'online' || !roomNet || onlineState?.status !== 'playing') return;
  ui.showRoomModal({
    title: 'Xác nhận đầu hàng',
    message: 'Bạn có chắc chắn muốn đầu hàng không? Đối thủ sẽ giành chiến thắng ngay lập tức.',
    actions: [
      {
        label: 'Xác nhận đầu hàng',
        danger: true,
        onClick: async () => {
          ui.hideRoomModal();
          const res = await roomNet.resign();
          if (!res.ok) {
            ui.showToast(res.error || 'Không thể đầu hàng', 'warn');
          }
        },
      },
      {
        label: 'Hủy',
        onClick: () => ui.hideRoomModal(),
      },
    ],
  });
}

async function handleOfferDraw() {
  if (route.mode !== 'online' || !roomNet || onlineState?.status !== 'playing') return;
  const res = await roomNet.offerDraw();
  if (!res.ok) {
    ui?.showToast(res.error || 'Không thể gửi đề nghị hòa', 'warn');
    return;
  }
  if (!res.acceptedImmediately) {
    ui?.showToast('Đã gửi lời đề nghị hòa tới đối thủ', 'info');
  }
}

async function handleRespondDraw(accept) {
  if (route.mode !== 'online' || !roomNet || onlineState?.status !== 'playing') return;
  const res = await roomNet.respondDraw(accept);
  if (!res.ok) {
    ui?.showToast(res.error || 'Không thể phản hồi đề nghị hòa', 'warn');
  }
}

function handleFlipBoard() {
  if (!chessScene) return;
  cameraSide = cameraSide === 'w' ? 'b' : 'w';
  chessScene.setCameraSide(cameraSide);
}

function handleToggleCoords() {
  if (!chessScene) return;
  coordsVisible = !coordsVisible;
  chessScene.setCoordsVisible(coordsVisible);
  ui?.setCoordsButtonLabel(coordsVisible);
}

function handleToggleAudio() {
  const muted = audio.toggleMute();
  ui?.setAudioMutedLabel(muted);
  if (!muted) {
    audio.playMove();
  }
}

async function handleSendChat(text) {
  if (route.mode !== 'online' || !roomNet) return false;
  const res = await roomNet.sendChat(text);
  if (!res.ok) {
    ui?.showToast(res.error || 'Không thể gửi tin nhắn', 'warn');
    return false;
  }
  return true;
}

/** Khởi tạo kết nối Socket.IO cho phòng online */
function initOnlineConnection(roomId) {
  roomNet?.dispose();
  roomNet = createRoomNetwork(roomId, {
    onConnectionChange: (status) => {
      ui.setConnectionStatus(status);
      if (status === 'disconnected') {
        ui.showToast('Mất kết nối máy chủ — đang tự động kết nối lại...', 'warn');
      }
    },

    onJoinError: (err) => {
      loadingOverlay.classList.add('hidden');
      const title =
        err.code === 'ROOM_FULL'
          ? 'Phòng đã đầy'
          : err.code === 'ROOM_NOT_FOUND'
            ? 'Không tìm thấy phòng'
            : 'Không thể vào phòng';

      ui.showRoomModal({
        title,
        message: err.error || 'Phòng không tồn tại hoặc không thể kết nối.',
        actions: [
          {
            label: 'Tạo phòng mới',
            primary: true,
            onClick: () => {
              window.location.href = '/new';
            },
          },
          {
            label: 'Về trang chủ',
            onClick: () => {
              window.location.href = '/';
            },
          },
        ],
      });
    },

    onJoined: (state, { reconnected }) => {
      ui.hideRoomModal();
      applyServerRoomState(state, { orientCamera: true });

      if (reconnected) {
        ui.showToast('Đã khôi phục ghế ngồi và trạng thái ván cờ!', 'success');
      } else if (state.role === 'w') {
        ui.showToast('Bạn là Quân Trắng — Copy link để mời đối thủ!', 'info');
      } else if (state.role === 'b') {
        ui.showToast('Bạn là Quân Đen — Ván đấu bắt đầu!', 'success');
      } else {
        ui.showToast('Bạn đang vào phòng với tư cách Khán giả', 'info');
      }
    },

    onRoomState: (state) => {
      // Nhận trạng thái mới hoàn toàn (vd: bắt đầu ván tái đấu có đổi màu Trắng <-> Đen)
      const prevRole = onlineState?.role;
      applyServerRoomState(state, { orientCamera: prevRole !== state.role });
    },

    onPlayersUpdate: (payload) => {
      if (!onlineState) return;
      const prevStatus = onlineState.status;
      onlineState = {
        ...onlineState,
        players: payload.players,
        spectatorCount: payload.spectatorCount,
        status: payload.status,
        clock: payload.clock || onlineState.clock,
        drawOffer: payload.drawOffer ?? onlineState.drawOffer,
        rematchVotes: payload.rematchVotes || [],
      };
      syncBoardAndUI();

      if (prevStatus === 'waiting' && payload.status === 'playing') {
        ui.showToast('Đối thủ đã vào phòng — Trận đấu bắt đầu!', 'success');
      }
    },

    onMoved: (payload) => {
      if (!onlineState) return;
      onlineState = {
        ...onlineState,
        fen: payload.fen,
        turn: payload.turn,
        inCheck: payload.inCheck,
        history: payload.history,
        lastMove: payload.lastMove,
        status: payload.status,
        result: payload.result,
        clock: payload.clock || onlineState.clock,
        drawOffer: payload.drawOffer ?? null,
      };
      chess.load(payload.fen);
      inputController?.clearSelection();
      syncBoardAndUI({ animateMove: payload.move });

      triggerMoveFeedback({
        move: payload.move,
        inCheck: payload.inCheck,
        isFinished: payload.status === 'finished',
        result: payload.result,
        myRole: onlineState.role,
      });

      if (payload.status === 'finished') {
        ui.showToast(formatResultText(payload.result), 'success');
      } else if (payload.inCheck) {
        ui.showToast('Chiếu!', 'warn');
      }
    },

    onClockSync: (payload) => {
      if (!onlineState) return;
      if (payload.players) {
        onlineState = { ...onlineState, players: payload.players };
      }
      if (payload.clock) {
        onlineState = { ...onlineState, clock: payload.clock };
        syncClockFromServer(payload.clock);
      }
      ui.updateOnlineRoomInfo({
        role: onlineState.role,
        players: onlineState.players,
        spectatorCount: onlineState.spectatorCount,
        status: onlineState.status,
        drawOffer: onlineState.drawOffer || null,
        rematchVotes: onlineState.rematchVotes,
      });
    },

    onGameEnded: (payload) => {
      if (!onlineState) return;
      onlineState = {
        ...onlineState,
        status: payload.status || 'finished',
        result: payload.result,
        clock: payload.clock || onlineState.clock,
        drawOffer: null,
        rematchVotes: payload.rematchVotes || [],
      };
      inputController?.clearSelection();
      syncBoardAndUI();
      playOutcomeAudio(payload.result, onlineState.role);
      ui.showToast(formatResultText(payload.result), 'success');
    },

    onDrawOffer: (payload) => {
      if (!onlineState) return;
      onlineState = {
        ...onlineState,
        drawOffer: payload.drawOffer || null,
      };
      syncBoardAndUI();

      if (payload.drawOffer && payload.drawOffer.by !== onlineState.role && onlineState.role !== 'spectator') {
        ui.showToast('Đối thủ vừa gửi lời đề nghị hòa!', 'info');
      } else if (payload.declinedBy && payload.declinedBy !== onlineState.role) {
        ui.showToast('Đối thủ đã từ chối lời đề nghị hòa.', 'warn');
      }
    },

    onChatMessage: (message) => {
      if (!onlineState) return;
      const list = onlineState.chatMessages || [];
      list.push(message);
      if (list.length > 60) list.shift();
      onlineState.chatMessages = list;

      ui.appendChatMessage(message, onlineState.role);
      if (message.senderRole !== onlineState.role) {
        audio.playChat();
      }
    },

    onNotice: (message) => {
      if (message) ui.showToast(message, 'info');
    },

    onReplaced: (message) => {
      inputController?.setEnabled(false);
      ui.showRoomModal({
        title: 'Trùng phiên người chơi',
        message:
          `${message} (Nếu bạn đang mở 2 tab trên cùng trình duyệt để thử đấu 2 bên, hãy bấm nút bên dưới để vào bằng ghế người chơi khác.)`,
        actions: [
          {
            label: 'Vào với tư cách người chơi mới (Tab test)',
            primary: true,
            onClick: () => {
              ui.hideRoomModal();
              roomNet?.rejoinAsNewTabIdentity();
            },
          },
          {
            label: 'Về trang chủ',
            onClick: () => {
              window.location.href = '/';
            },
          },
        ],
      });
    },
  });

  roomNet.connect();
}

function cleanup() {
  if (clockIntervalId) {
    clearInterval(clockIntervalId);
    clockIntervalId = null;
  }
  roomNet?.dispose();
  inputController?.dispose();
  highlights?.dispose();
  piecesManager?.dispose();
  chessAssets?.dispose();
  chessScene?.dispose();
  roomNet = null;
  inputController = null;
  highlights = null;
  piecesManager = null;
  chessAssets = null;
  chessScene = null;
  assetsReady = false;
}

async function init3DBoard() {
  errorOverlay.classList.add('hidden');
  loadingOverlay.classList.remove('hidden');
  setLoadingState({
    title: 'Đang tải bộ cờ 3D...',
    detail: 'Đang kết nối tới mô hình 3D...',
    percent: 0,
  });

  try {
    chessScene = createChessScene(canvas);
    const initialSide = onlineState?.role === 'b' ? 'b' : 'w';
    cameraSide = initialSide;
    chessScene.setCameraSide(initialSide, true);
    if (onlineState) hasInitialCameraOriented = true;

    chessScene.startLoop((dt) => {
      piecesManager?.update(dt);
      highlights?.update(dt);
    });

    const maxAnisotropy = chessScene.renderer.capabilities.getMaxAnisotropy();
    chessAssets = await loadChessAssets(MODEL_URL, {
      maxAnisotropy,
      onProgress: ({ loaded, total, percent }) => {
        if (percent !== null) {
          const uiPercent = Math.round(percent * 0.9);
          setLoadingState({
            title: percent >= 100 ? 'Đang xử lý & chuẩn hóa model 3D...' : 'Đang tải bộ cờ 3D...',
            detail:
              percent >= 100
                ? 'Đang giải mã mesh, căn tâm bàn cờ và 12 bản mẫu quân cờ...'
                : `Đã tải ${formatMB(loaded)} / ${formatMB(total)}`,
            percent: uiPercent,
          });
        } else {
          setLoadingState({ detail: `Đã tải ${formatMB(loaded)}...` });
        }
      },
    });

    setLoadingState({
      title: 'Đang xếp bàn cờ...',
      detail: 'Hoàn tất chuẩn hóa hệ tọa độ 8x8',
      percent: 96,
    });

    chessScene.scene.add(chessAssets.board);
    piecesManager = new BoardPiecesManager(chessScene.scene, chessAssets);
    highlights = new BoardHighlights(chessScene.scene);

    inputController = new ChessInputController({
      canvas,
      camera: chessScene.camera,
      controls: chessScene.controls,
      piecesManager,
      highlights,
      canSelectSquare,
      getLegalMovesForSquare,
      onAttemptMove: handleAttemptMove,
      onInvalidSquare: () => {
        audio.playInvalid();
        ui.showToast('Ô này không đi được', 'warn');
      },
    });

    assetsReady = true;
    syncBoardAndUI();

    setLoadingState({ percent: 100 });
    requestAnimationFrame(() => {
      loadingOverlay.classList.add('hidden');
      hudStatus.textContent =
        route.mode === 'online'
          ? 'Chạm hoặc kéo quân của bạn khi đến lượt • Kéo nền để xoay camera'
          : 'Chạm hoặc kéo quân để đi cờ • Kéo nền để xoay camera';
    });
  } catch (err) {
    showError(err);
  }
}

function bootstrap() {
  ui = createGameUI({
    onNewGame: handleNewGame,
    onUndo: handleUndo,
    onRematch: handleRematch,
    onResignClick: handleResignClick,
    onOfferDraw: handleOfferDraw,
    onRespondDraw: handleRespondDraw,
    onSendChat: handleSendChat,
    onToggleAudio: handleToggleAudio,
    onFlipBoard: handleFlipBoard,
    onToggleCoords: handleToggleCoords,
    onGoHome: () => {
      window.location.href = '/';
    },
    onCreateRoom: (name, timeControl) => {
      savePlayerName(name);
      const tcParam = timeControl ? `?tc=${encodeURIComponent(timeControl)}` : '';
      window.location.href = `/new${tcParam}`;
    },
    onJoinRoom: (roomId, name) => {
      savePlayerName(name);
      window.location.href = `/room/${encodeURIComponent(roomId)}`;
    },
    onPlayLocal: () => {
      window.location.href = '/local';
    },
  });

  ui.setAudioMutedLabel(audio.isMuted());
  ui.setMode(route.mode, route.roomId || '');

  // Tại trang chủ `/` chỉ hiển thị Lobby (chưa tải model 145MB cho đến khi vào phòng / chơi cục bộ)
  if (route.mode === 'lobby') {
    loadingOverlay.classList.add('hidden');
    hudStatus.textContent = 'Tạo phòng mới hoặc nhập mã phòng để bắt đầu';
    ui.showLobby(getSavedPlayerName());
    return;
  }

  // Tại `/room/:id`: kết nối Socket.IO song song với tải model 3D và bật vòng lặp nội suy đồng hồ
  if (route.mode === 'online') {
    initOnlineConnection(route.roomId);
    clockIntervalId = setInterval(renderInterpolatedClock, 100);
  }

  init3DBoard();
}

btnRetry.addEventListener('click', () => {
  cleanup();
  if (route.mode === 'online') {
    initOnlineConnection(route.roomId);
    clockIntervalId = setInterval(renderInterpolatedClock, 100);
  }
  init3DBoard();
});

window.addEventListener('beforeunload', () => {
  cleanup();
  audio.dispose();
});

bootstrap();
