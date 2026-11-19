/**
 * Quản lý giao diện người dùng (UI):
 * - Lobby tạo phòng / vào phòng / chơi cục bộ
 * - Panel bên cạnh: thông tin phòng, copy link, tên & trạng thái kết nối 2 người chơi,
 *   lượt đi, trạng thái ván cờ, quân bị bắt & chênh lệch điểm, lịch sử nước đi (SAN)
 * - Hộp chọn phong cấp (Hậu / Xe / Tượng / Mã), hộp thông báo phòng (lỗi/trùng tab), toast
 */

const PIECE_UNICODE = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_SORT_ORDER = ['q', 'r', 'b', 'n', 'p'];
const INITIAL_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };

/**
 * Tính các quân đã bị bắt và điểm vật chất chênh lệch dựa trên bàn cờ hiện tại (từ chess.board()).
 */
export function computeCapturedPieces(board2D) {
  const present = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };

  for (const row of board2D) {
    for (const cell of row) {
      if (cell) {
        present[cell.color][cell.type] += 1;
      }
    }
  }

  const capturedByWhite = [];
  const capturedByBlack = [];

  for (const type of PIECE_SORT_ORDER) {
    const missingBlack = Math.max(0, INITIAL_COUNTS[type] - present.b[type]);
    for (let i = 0; i < missingBlack; i++) capturedByWhite.push(type);

    const missingWhite = Math.max(0, INITIAL_COUNTS[type] - present.w[type]);
    for (let i = 0; i < missingWhite; i++) capturedByBlack.push(type);
  }

  let whiteMaterial = 0;
  let blackMaterial = 0;
  for (const type of PIECE_SORT_ORDER) {
    whiteMaterial += present.w[type] * PIECE_VALUES[type];
    blackMaterial += present.b[type] * PIECE_VALUES[type];
  }

  return {
    capturedByWhite,
    capturedByBlack,
    whiteAdvantage: Math.max(0, whiteMaterial - blackMaterial),
    blackAdvantage: Math.max(0, blackMaterial - whiteMaterial),
  };
}

/** Trích xuất mã phòng từ chuỗi người dùng nhập (có thể là mã trần hoặc cả URL) */
export function extractRoomIdFromInput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/room\/([a-zA-Z0-9_-]{4,24})/);
  if (match) return match[1];
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Copy văn bản vào clipboard (có fallback cho môi trường HTTP không phải localhost) */
async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function createGameUI(handlers = {}) {
  const sidebar = document.getElementById('sidebar');
  const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  const btnToggleAudio = document.getElementById('btn-toggle-audio');

  const turnIndicator = document.getElementById('turn-indicator');
  const roleBadge = document.getElementById('role-badge');
  const sidebarModeTitle = document.getElementById('sidebar-mode-title');
  const sidebarSub = document.getElementById('sidebar-sub');
  const connBadge = document.getElementById('conn-badge');

  const roomBar = document.getElementById('room-bar');
  const roomCodeValue = document.getElementById('room-code-value');
  const roomTcLabel = document.getElementById('room-tc-label');
  const btnCopyLink = document.getElementById('btn-copy-link');
  const spectatorInfo = document.getElementById('spectator-info');

  const gameStatusBanner = document.getElementById('game-status-banner');
  const drawOfferBanner = document.getElementById('draw-offer-banner');
  const drawOfferText = document.getElementById('draw-offer-text');
  const btnAcceptDraw = document.getElementById('btn-accept-draw');
  const btnDeclineDraw = document.getElementById('btn-decline-draw');

  const playerNameW = document.getElementById('player-name-w');
  const playerNameB = document.getElementById('player-name-b');
  const playerConnW = document.getElementById('player-conn-w');
  const playerConnB = document.getElementById('player-conn-b');
  const clockWEl = document.getElementById('clock-w');
  const clockBEl = document.getElementById('clock-b');

  const capturedByWhiteEl = document.getElementById('captured-by-white');
  const capturedByBlackEl = document.getElementById('captured-by-black');
  const moveListEl = document.getElementById('move-list');

  const tabMoves = document.getElementById('tab-moves');
  const tabChat = document.getElementById('tab-chat');
  const paneMoves = document.getElementById('pane-moves');
  const paneChat = document.getElementById('pane-chat');
  const chatUnreadBadge = document.getElementById('chat-unread-badge');
  const chatListEl = document.getElementById('chat-list');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const btnChatSend = document.getElementById('btn-chat-send');
  let activeTab = 'moves';
  let unreadChatCount = 0;

  const btnOfferDraw = document.getElementById('btn-offer-draw');
  const btnResign = document.getElementById('btn-resign');
  const btnRematch = document.getElementById('btn-rematch');
  const btnNewGame = document.getElementById('btn-new-game');
  const btnUndo = document.getElementById('btn-undo');
  const btnFlipBoard = document.getElementById('btn-flip-board');
  const btnToggleCoords = document.getElementById('btn-toggle-coords');
  const btnHome = document.getElementById('btn-home');

  const lobbyOverlay = document.getElementById('lobby-overlay');
  const inputPlayerName = document.getElementById('input-player-name');
  const tcSelector = document.getElementById('tc-selector');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const formJoinRoom = document.getElementById('form-join-room');
  const inputRoomCode = document.getElementById('input-room-code');
  const btnPlayLocal = document.getElementById('btn-play-local');
  let selectedTimeControl = '10+0';

  const roomModalOverlay = document.getElementById('room-modal-overlay');
  const roomModalTitle = document.getElementById('room-modal-title');
  const roomModalMessage = document.getElementById('room-modal-message');
  const roomModalActions = document.getElementById('room-modal-actions');

  const promoOverlay = document.getElementById('promotion-overlay');
  const promoChoices = document.getElementById('promotion-choices');
  const btnPromoCancel = document.getElementById('btn-promo-cancel');

  const toastEl = document.getElementById('toast');
  let toastTimer = null;

  btnToggleSidebar?.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  btnToggleAudio?.addEventListener('click', () => handlers.onToggleAudio?.());

  function switchTab(tab) {
    activeTab = tab;
    const isMoves = tab === 'moves';
    tabMoves?.classList.toggle('tab-active', isMoves);
    tabChat?.classList.toggle('tab-active', !isMoves);
    paneMoves?.classList.toggle('hidden', !isMoves);
    paneChat?.classList.toggle('hidden', isMoves);
    if (!isMoves) {
      unreadChatCount = 0;
      if (chatUnreadBadge) {
        chatUnreadBadge.textContent = '0';
        chatUnreadBadge.classList.add('hidden');
      }
      if (chatListEl) {
        chatListEl.scrollTop = chatListEl.scrollHeight;
      }
    }
  }

  tabMoves?.addEventListener('click', () => switchTab('moves'));
  tabChat?.addEventListener('click', () => switchTab('chat'));

  chatForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = (chatInput?.value || '').trim();
    if (!raw) return;
    const ok = await handlers.onSendChat?.(raw);
    if (ok && chatInput) {
      chatInput.value = '';
    }
  });

  btnNewGame?.addEventListener('click', () => handlers.onNewGame?.());
  btnUndo?.addEventListener('click', () => handlers.onUndo?.());
  btnFlipBoard?.addEventListener('click', () => handlers.onFlipBoard?.());
  btnToggleCoords?.addEventListener('click', () => handlers.onToggleCoords?.());
  btnRematch?.addEventListener('click', () => handlers.onRematch?.());
  btnOfferDraw?.addEventListener('click', () => handlers.onOfferDraw?.());
  btnResign?.addEventListener('click', () => handlers.onResignClick?.());
  btnAcceptDraw?.addEventListener('click', () => handlers.onRespondDraw?.(true));
  btnDeclineDraw?.addEventListener('click', () => handlers.onRespondDraw?.(false));
  btnHome?.addEventListener('click', () => handlers.onGoHome?.());

  // Chọn chế độ đồng hồ trên màn hình Lobby
  tcSelector?.addEventListener('click', (e) => {
    const chip = e.target.closest('.tc-chip');
    if (!chip) return;
    selectedTimeControl = chip.dataset.tc || '10+0';
    for (const el of tcSelector.querySelectorAll('.tc-chip')) {
      el.classList.toggle('tc-active', el === chip);
    }
  });

  btnCopyLink?.addEventListener('click', async () => {
    try {
      await copyTextToClipboard(window.location.href);
      showToast('Đã sao chép link phòng!', 'success');
    } catch {
      showToast('Không thể tự sao chép — hãy copy URL trên thanh địa chỉ', 'warn');
    }
  });

  btnCreateRoom?.addEventListener('click', () => {
    handlers.onCreateRoom?.(inputPlayerName?.value || '', selectedTimeControl);
  });

  formJoinRoom?.addEventListener('submit', (e) => {
    e.preventDefault();
    const roomId = extractRoomIdFromInput(inputRoomCode?.value || '');
    if (!roomId || roomId.length < 4) {
      showToast('Vui lòng nhập mã phòng hợp lệ', 'warn');
      return;
    }
    handlers.onJoinRoom?.(roomId, inputPlayerName?.value || '');
  });

  btnPlayLocal?.addEventListener('click', () => {
    handlers.onPlayLocal?.();
  });

  function showToast(message, type = 'info') {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = `toast show toast-${type}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2400);
  }

  function setCoordsButtonLabel(visible) {
    if (btnToggleCoords) {
      btnToggleCoords.textContent = visible ? 'Ẩn tọa độ' : 'Hiện tọa độ';
    }
  }

  function setAudioMutedLabel(muted) {
    if (btnToggleAudio) {
      btnToggleAudio.textContent = muted ? 'Âm thanh: Tắt' : 'Âm thanh: Bật';
    }
  }

  /** Chuyển đổi giao diện giữa chế độ Lobby, Online (/room/:id), và Cục bộ (/local) */
  function setMode(mode, roomId = '') {
    const isOnline = mode === 'online';
    const isLocal = mode === 'local';

    roomBar?.classList.toggle('hidden', !isOnline);
    connBadge?.classList.toggle('hidden', !isOnline);
    roleBadge?.classList.toggle('hidden', !isOnline);
    tabChat?.classList.toggle('hidden', !isOnline);
    if (!isOnline) {
      switchTab('moves');
    }
    btnHome?.classList.toggle('hidden', mode === 'lobby');

    btnNewGame?.classList.toggle('hidden', !isLocal);
    btnUndo?.classList.toggle('hidden', !isLocal);
    btnRematch?.classList.add('hidden');
    btnOfferDraw?.classList.add('hidden');
    btnResign?.classList.add('hidden');
    drawOfferBanner?.classList.add('hidden');
    clockWEl?.classList.toggle('hidden', !isOnline);
    clockBEl?.classList.toggle('hidden', !isOnline);

    if (isOnline) {
      sidebarModeTitle.textContent = 'Đấu trực tuyến';
      sidebarSub.textContent = 'Đồng bộ realtime qua Socket.IO';
      roomCodeValue.textContent = roomId;
    } else if (isLocal) {
      sidebarModeTitle.textContent = 'Chơi cục bộ';
      sidebarSub.textContent = 'Chế độ 2 người trên cùng 1 máy';
      playerNameW.textContent = 'Quân Trắng';
      playerNameB.textContent = 'Quân Đen';
      playerConnW.className = 'conn-dot conn-online';
      playerConnB.className = 'conn-dot conn-online';
    } else {
      sidebarModeTitle.textContent = 'Cờ Vua 3D';
      sidebarSub.textContent = 'Tạo phòng để chơi online';
    }
  }

  function showLobby(savedName = '') {
    if (inputPlayerName && !inputPlayerName.value) {
      inputPlayerName.value = savedName;
    }
    lobbyOverlay?.classList.remove('hidden');
  }

  function hideLobby() {
    lobbyOverlay?.classList.add('hidden');
  }

  function setConnectionStatus(status) {
    if (!connBadge) return;
    if (status === 'connected') {
      connBadge.textContent = 'Trực tuyến';
      connBadge.className = 'conn-badge conn-ok';
    } else if (status === 'connecting') {
      connBadge.textContent = 'Đang kết nối...';
      connBadge.className = 'conn-badge';
    } else {
      connBadge.textContent = 'Mất kết nối';
      connBadge.className = 'conn-badge conn-bad';
    }
  }

  function _updatePlayerRow(nameEl, dotEl, seatData, defaultLabel, isMe) {
    if (!seatData) {
      nameEl.textContent = `${defaultLabel} (Đang chờ...)`;
      dotEl.className = 'conn-dot conn-idle';
      dotEl.title = 'Đang chờ người chơi vào';
      return;
    }
    const suffix = isMe ? ' (Bạn)' : '';
    const offlineTag = seatData.connected ? '' : ' • Rớt mạng';
    nameEl.textContent = `${seatData.name}${suffix}${offlineTag}`;
    dotEl.className = `conn-dot ${seatData.connected ? 'conn-online' : 'conn-offline'}`;
    dotEl.title = seatData.connected ? 'Đang trực tuyến' : 'Đang mất kết nối';
  }

  /** Định dạng thời gian còn lại: MM:SS (hoặc SS.d khi dưới 20 giây) */
  function formatClockMs(ms) {
    const safeMs = Math.max(0, Math.ceil(ms));
    if (safeMs < 20_000) {
      const secs = Math.floor(safeMs / 1000);
      const tenths = Math.floor((safeMs % 1000) / 100);
      return `0:${String(secs).padStart(2, '0')}.${tenths}`;
    }
    const totalSec = Math.ceil(safeMs / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  /** Cập nhật hiển thị đồng hồ 2 bên (chạy nội suy mượt từ snapshot server) */
  function renderClocks(clockView) {
    if (!clockWEl || !clockBEl || !clockView) return;

    if (roomTcLabel && clockView.label) {
      roomTcLabel.textContent = clockView.label;
    }

    clockWEl.classList.remove('hidden');
    clockBEl.classList.remove('hidden');

    if (clockView.unlimited) {
      clockWEl.textContent = '∞';
      clockBEl.textContent = '∞';
      clockWEl.className = `clock-box${clockView.running && clockView.activeColor === 'w' ? ' clock-active' : ''}`;
      clockBEl.className = `clock-box${clockView.running && clockView.activeColor === 'b' ? ' clock-active' : ''}`;
      return;
    }

    const applyBox = (el, ms, color) => {
      el.textContent = formatClockMs(ms);
      const isTurn = clockView.running && clockView.activeColor === color;
      const classes = ['clock-box'];
      if (clockView.paused && isTurn) {
        classes.push('clock-paused');
      } else if (isTurn && ms < 20_000) {
        classes.push('clock-low');
      } else if (isTurn) {
        classes.push('clock-active');
      }
      el.className = classes.join(' ');
      el.title = clockView.paused ? 'Đồng hồ tạm dừng (đối thủ vừa mất kết nối)' : '';
    };

    applyBox(clockWEl, clockView.wMs, 'w');
    applyBox(clockBEl, clockView.bMs, 'b');
  }

  /** Cập nhật thông tin phòng online (vai trò, tên, kết nối, khán giả, xin hòa, đầu hàng, tái đấu) */
  function updateOnlineRoomInfo({ role, players, spectatorCount, status, drawOffer = null, rematchVotes = [] }) {
    if (roleBadge) {
      const roleLabels = {
        w: 'Bạn: Trắng',
        b: 'Bạn: Đen',
        spectator: 'Khán giả',
      };
      roleBadge.textContent = roleLabels[role] || 'Khán giả';
      roleBadge.classList.remove('hidden');
    }

    _updatePlayerRow(playerNameW, playerConnW, players?.w, 'Quân Trắng', role === 'w');
    _updatePlayerRow(playerNameB, playerConnB, players?.b, 'Quân Đen', role === 'b');

    if (spectatorInfo) {
      if (spectatorCount > 0) {
        spectatorInfo.textContent = `Đang có ${spectatorCount} khán giả theo dõi`;
        spectatorInfo.classList.remove('hidden');
      } else {
        spectatorInfo.classList.add('hidden');
      }
    }

    const isPlayer = role === 'w' || role === 'b';
    const isPlaying = status === 'playing';

    // Khóa ô gửi chat nếu là Khán giả (chỉ 2 người chơi được gửi tin nhắn)
    if (chatInput && btnChatSend) {
      chatInput.disabled = !isPlayer;
      btnChatSend.disabled = !isPlayer;
      chatInput.placeholder = isPlayer
        ? 'Nhắn tin cho đối thủ...'
        : 'Khán giả chỉ có thể xem tin nhắn';
    }

    // Nút Xin hòa & Đầu hàng chỉ hiện với 2 người chơi trong lúc đang đấu
    if (btnOfferDraw) {
      const showDraw = isPlayer && isPlaying;
      btnOfferDraw.classList.toggle('hidden', !showDraw);
      if (showDraw) {
        const myOffer = drawOffer?.by === role;
        btnOfferDraw.disabled = myOffer;
        btnOfferDraw.textContent = myOffer ? 'Đã xin hòa...' : 'Xin hòa';
      }
    }

    if (btnResign) {
      btnResign.classList.toggle('hidden', !(isPlayer && isPlaying));
    }

    // Banner đề nghị hòa khi đối thủ gửi lời mời
    if (drawOfferBanner && drawOfferText) {
      const incomingDraw = isPlayer && isPlaying && drawOffer && drawOffer.by !== role;
      drawOfferBanner.classList.toggle('hidden', !incomingDraw);
      if (incomingDraw) {
        const senderSeat = players?.[drawOffer.by];
        const senderName = senderSeat?.name || (drawOffer.by === 'w' ? 'Quân Trắng' : 'Quân Đen');
        drawOfferText.textContent = `${senderName} đề nghị hòa ván này`;
      }
    }

    // Nút Chơi lại khi ván kết thúc
    if (btnRematch) {
      const canRematch = status === 'finished' && isPlayer;
      btnRematch.classList.toggle('hidden', !canRematch);
      if (canRematch) {
        const myVoted = rematchVotes.includes(role);
        btnRematch.disabled = myVoted;
        if (myVoted) {
          btnRematch.textContent = 'Đang chờ đối thủ (1/2)...';
        } else if (rematchVotes.length > 0) {
          btnRematch.textContent = 'Chấp nhận chơi lại!';
        } else {
          btnRematch.textContent = 'Chơi lại (Đổi màu)';
        }
      }
    }
  }

  /** Hiển thị hộp thông báo phòng / xác nhận đầu hàng */
  function showRoomModal({ title, message, actions = [] }) {
    roomModalTitle.textContent = title;
    roomModalMessage.textContent = message;
    roomModalActions.textContent = '';

    for (const act of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      let cls = 'btn';
      if (act.primary) cls = 'btn btn-primary';
      else if (act.danger) cls = 'btn btn-danger';
      btn.className = cls;
      btn.textContent = act.label;
      btn.addEventListener('click', () => act.onClick?.());
      roomModalActions.appendChild(btn);
    }

    roomModalOverlay?.classList.remove('hidden');
  }

  function hideRoomModal() {
    roomModalOverlay?.classList.add('hidden');
  }

  function renderCapturedRow(container, pieces, colorOfPieces, advantage) {
    container.textContent = '';
    if (pieces.length === 0 && advantage === 0) {
      const empty = document.createElement('span');
      empty.className = 'captured-empty';
      empty.textContent = 'Chưa có';
      container.appendChild(empty);
      return;
    }

    for (const type of pieces) {
      const span = document.createElement('span');
      span.className = `cap-icon cap-${colorOfPieces}`;
      span.textContent = PIECE_UNICODE[colorOfPieces][type];
      container.appendChild(span);
    }

    if (advantage > 0) {
      const adv = document.createElement('span');
      adv.className = 'material-adv';
      adv.textContent = `+${advantage}`;
      container.appendChild(adv);
    }
  }

  function renderMoveHistory(sanList) {
    moveListEl.textContent = '';
    if (!sanList || sanList.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'moves-empty';
      empty.textContent = 'Chưa có nước đi nào';
      moveListEl.appendChild(empty);
      return;
    }

    for (let i = 0; i < sanList.length; i += 2) {
      const row = document.createElement('div');
      row.className = 'move-row';

      const num = document.createElement('span');
      num.className = 'move-num';
      num.textContent = `${Math.floor(i / 2) + 1}.`;

      const whiteMove = document.createElement('span');
      whiteMove.className = 'move-san' + (i === sanList.length - 1 ? ' move-latest' : '');
      whiteMove.textContent = sanList[i];

      const blackMove = document.createElement('span');
      blackMove.className = 'move-san' + (i + 1 === sanList.length - 1 ? ' move-latest' : '');
      blackMove.textContent = sanList[i + 1] || '';

      row.append(num, whiteMove, blackMove);
      moveListEl.appendChild(row);
    }

    moveListEl.scrollTop = moveListEl.scrollHeight;
  }

  function updateGameState({ turn, statusText, statusTone, historySan, board2D, canUndo }) {
    if (turnIndicator) {
      const isWhite = turn === 'w';
      turnIndicator.textContent = isWhite ? 'Lượt Quân Trắng' : 'Lượt Quân Đen';
      turnIndicator.className = `turn-pill ${isWhite ? 'turn-white' : 'turn-black'}`;
    }

    if (gameStatusBanner) {
      gameStatusBanner.textContent = statusText;
      gameStatusBanner.className = `status-banner tone-${statusTone || 'normal'}`;
    }

    if (btnUndo) {
      btnUndo.disabled = !canUndo;
    }

    const cap = computeCapturedPieces(board2D);
    renderCapturedRow(capturedByWhiteEl, cap.capturedByWhite, 'b', cap.whiteAdvantage);
    renderCapturedRow(capturedByBlackEl, cap.capturedByBlack, 'w', cap.blackAdvantage);
    renderMoveHistory(historySan);
  }

  function promptPromotion(color) {
    return new Promise((resolve) => {
      const options = [
        { type: 'q', label: 'Hậu' },
        { type: 'r', label: 'Xe' },
        { type: 'b', label: 'Tượng' },
        { type: 'n', label: 'Mã' },
      ];

      promoChoices.textContent = '';

      const finish = (choice) => {
        promoOverlay.classList.add('hidden');
        btnPromoCancel.removeEventListener('click', onCancel);
        window.removeEventListener('keydown', onKeyDown);
        resolve(choice);
      };

      const onCancel = () => finish(null);
      const onKeyDown = (e) => {
        if (e.key === 'Escape') finish(null);
      };

      for (const opt of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'promo-btn';

        const icon = document.createElement('span');
        icon.className = 'promo-icon';
        icon.textContent = PIECE_UNICODE[color][opt.type];

        const text = document.createElement('span');
        text.className = 'promo-label';
        text.textContent = opt.label;

        btn.append(icon, text);
        btn.addEventListener('click', () => finish(opt.type));
        promoChoices.appendChild(btn);
      }

      btnPromoCancel.addEventListener('click', onCancel);
      window.addEventListener('keydown', onKeyDown);
      promoOverlay.classList.remove('hidden');
    });
  }

  function _formatChatTime(ts) {
    const d = new Date(ts || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** Tạo phần tử DOM cho 1 tin nhắn chat bằng textContent thuần (chống XSS tuyệt đối) */
  function _buildChatNode(msg, myRole) {
    const item = document.createElement('div');
    const isMine = myRole && msg.senderRole === myRole;
    item.className = `chat-msg${isMine ? ' chat-mine' : ''}`;

    const head = document.createElement('div');
    head.className = 'chat-msg-head';

    const sender = document.createElement('span');
    sender.className = 'chat-sender';
    const sideTag = msg.senderRole === 'w' ? 'Trắng' : 'Đen';
    sender.textContent = `${msg.senderName} (${sideTag})`;

    const time = document.createElement('span');
    time.textContent = _formatChatTime(msg.timestamp);

    head.append(sender, time);

    const body = document.createElement('div');
    body.className = 'chat-text';
    body.textContent = msg.text;

    item.append(head, body);
    return item;
  }

  /** Nạp lại toàn bộ lịch sử chat (khi vào phòng / reconnect) */
  function setChatMessages(messages = [], myRole = null) {
    if (!chatListEl) return;
    chatListEl.textContent = '';
    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = 'Chưa có tin nhắn nào. Hãy gửi lời chào tới đối thủ!';
      chatListEl.appendChild(empty);
      return;
    }
    for (const msg of messages) {
      chatListEl.appendChild(_buildChatNode(msg, myRole));
    }
    chatListEl.scrollTop = chatListEl.scrollHeight;
  }

  /** Thêm 1 tin nhắn mới realtime và cập nhật badge chưa đọc nếu đang ở tab Nước đi */
  function appendChatMessage(msg, myRole = null) {
    if (!chatListEl || !msg) return;
    const emptyEl = chatListEl.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();

    chatListEl.appendChild(_buildChatNode(msg, myRole));
    chatListEl.scrollTop = chatListEl.scrollHeight;

    const isFromOther = msg.senderRole !== myRole;
    if (activeTab !== 'chat' && isFromOther && chatUnreadBadge) {
      unreadChatCount += 1;
      chatUnreadBadge.textContent = unreadChatCount > 99 ? '99+' : String(unreadChatCount);
      chatUnreadBadge.classList.remove('hidden');
    }
  }

  return {
    setMode,
    showLobby,
    hideLobby,
    setConnectionStatus,
    renderClocks,
    updateOnlineRoomInfo,
    showRoomModal,
    hideRoomModal,
    updateGameState,
    promptPromotion,
    showToast,
    setCoordsButtonLabel,
    setAudioMutedLabel,
    setChatMessages,
    appendChatMessage,
  };
}
