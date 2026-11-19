/**
 * Bộ điều khiển tương tác chuột và cảm ứng (Pointer Events) trên bàn cờ 3D:
 * - Dùng THREE.Raycaster kiểm tra hộp va chạm AABB của từng quân (siêu nhanh, không lag do mesh high-poly)
 *   kết hợp mặt phẳng mặt bàn y = 0.
 * - Hỗ trợ đồng thời cả hai kiểu chơi:
 *   1. Chạm-chạm (Click/Tap quân -> chạm ô đích)
 *   2. Kéo-thả (Nhấn giữ quân của mình và kéo sang ô đích)
 * - Không xung đột với OrbitControls: kéo ở nền/ô trống hoặc chạm 2 ngón (pinch zoom) vẫn xoay/zoom bình thường.
 */

import * as THREE from 'three';
import { worldToSquare } from './pieces.js';

const DRAG_THRESHOLD_PX = 7;
const DRAG_LIFT_Y = 0.48;

export class ChessInputController {
  /**
   * @param {{
   *   canvas: HTMLCanvasElement,
   *   camera: THREE.Camera,
   *   controls: import('three/examples/jsm/controls/OrbitControls.js').OrbitControls,
   *   piecesManager: import('./pieces.js').BoardPiecesManager,
   *   highlights: import('./pieces.js').BoardHighlights,
   *   canSelectSquare: (square: string) => boolean,
   *   getLegalMovesForSquare: (square: string) => Array<{ to: string, isCapture: boolean }>,
   *   onAttemptMove: (from: string, to: string) => void,
   *   onInvalidSquare?: (from: string, to: string) => void,
   *   onSelectChange?: (square: string | null) => void,
   * }} options
   */
  constructor(options) {
    this.canvas = options.canvas;
    this.camera = options.camera;
    this.controls = options.controls;
    this.piecesManager = options.piecesManager;
    this.highlights = options.highlights;

    this.canSelectSquare = options.canSelectSquare;
    this.getLegalMovesForSquare = options.getLegalMovesForSquare;
    this.onAttemptMove = options.onAttemptMove;
    this.onInvalidSquare = options.onInvalidSquare || null;
    this.onSelectChange = options.onSelectChange || null;

    this.enabled = true;
    this.selectedSquare = null;
    /** @type {Set<string>} */
    this.legalTargetsSet = new Set();

    // Tái sử dụng đối tượng toán học để tránh tạo rác bộ nhớ (GC) trong pointermove
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -DRAG_LIFT_Y);
    this.hitPoint = new THREE.Vector3();
    this.tempBox = new THREE.Box3();
    this.tempHit = new THREE.Vector3();

    // Trạng thái thao tác con trỏ hiện tại
    this.activePointers = new Set();
    this.pointerState = null;

    // Bind sự kiện
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onPointerCancel = this._handlePointerCancel.bind(this);

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerCancel);
  }

  /** Bật/tắt quyền tương tác (vd: tắt khi mở hộp phong cấp, hết ván hoặc là khán giả) */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this._cancelDrag();
      this.clearSelection();
    }
  }

  /** Xóa lựa chọn hiện tại */
  clearSelection() {
    this.selectedSquare = null;
    this.legalTargetsSet.clear();
    this.piecesManager.setSelectedSquare(null);
    this.highlights.clearSelection();
    if (this.onSelectChange) this.onSelectChange(null);
  }

  /** Chọn một ô có quân hợp lệ và tô sáng các nước đi có thể */
  selectSquare(square) {
    if (!square || !this.canSelectSquare(square)) {
      this.clearSelection();
      return false;
    }

    const legalTargets = this.getLegalMovesForSquare(square);
    this.selectedSquare = square;
    this.legalTargetsSet = new Set(legalTargets.map((m) => m.to));

    this.piecesManager.setSelectedSquare(square);
    this.highlights.setSelected(square);
    this.highlights.setLegalTargets(legalTargets);
    if (this.onSelectChange) this.onSelectChange(square);
    return true;
  }

  /** Cập nhật tia Raycaster từ tọa độ màn hình (clientX, clientY) */
  _setRayFromClient(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  /**
   * Tìm ô cờ dưới con trỏ:
   * - Ưu tiên hộp va chạm AABB của quân cờ (gần camera nhất) để chạm trúng thân/đầu quân ở góc nghiêng
   * - Nếu không trúng quân, lấy giao điểm với mặt phẳng bàn cờ y = 0
   */
  _pickSquare(clientX, clientY, ignoreDraggedPiece = false) {
    this._setRayFromClient(clientX, clientY);

    let closestSq = null;
    let closestDistSq = Infinity;

    for (const [sq, piece] of this.piecesManager.bySquare.entries()) {
      if (ignoreDraggedPiece && sq === this.piecesManager.draggingSquare) continue;

      const halfW = piece.userData.hitHalfW ?? 0.35;
      const height = piece.userData.hitHeight ?? 1.2;
      const px = piece.position.x;
      const py = piece.position.y;
      const pz = piece.position.z;

      this.tempBox.min.set(px - halfW, py, pz - halfW);
      this.tempBox.max.set(px + halfW, py + height, pz + halfW);

      if (this.raycaster.ray.intersectBox(this.tempBox, this.tempHit)) {
        const dSq = this.camera.position.distanceToSquared(this.tempHit);
        if (dSq < closestDistSq) {
          closestDistSq = dSq;
          closestSq = sq;
        }
      }
    }

    if (closestSq) {
      return closestSq;
    }

    if (this.raycaster.ray.intersectPlane(this.boardPlane, this.hitPoint)) {
      return worldToSquare(this.hitPoint.x, this.hitPoint.z);
    }

    return null;
  }

  /** Lấy tọa độ trên mặt phẳng kéo (y = DRAG_LIFT_Y) để quân bám mượt theo con trỏ */
  _raycastDragPlane(clientX, clientY) {
    this._setRayFromClient(clientX, clientY);
    if (this.raycaster.ray.intersectPlane(this.dragPlane, this.hitPoint)) {
      // Kẹp nhẹ trong phạm vi bàn cờ để quân không bay mất khỏi tầm nhìn
      this.hitPoint.x = Math.max(-4.5, Math.min(4.5, this.hitPoint.x));
      this.hitPoint.z = Math.max(-4.5, Math.min(4.5, this.hitPoint.z));
      return this.hitPoint;
    }
    return null;
  }

  _cancelDrag() {
    if (this.pointerState?.isDragging) {
      this.piecesManager.setDraggingSquare(null);
      this.highlights.setHover(null);
    }
    if (this.pointerState?.controlsLocked) {
      this.controls.enabled = true;
    }
    this.pointerState = null;
    this.canvas.style.cursor = 'default';
  }

  _handlePointerDown(e) {
    this.activePointers.add(e.pointerId);

    // Nếu chạm >= 2 ngón tay (zoom/xoay trên điện thoại), hủy thao tác kéo và trả quyền cho OrbitControls
    if (this.activePointers.size > 1) {
      this._cancelDrag();
      return;
    }

    if (!this.enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const sq = this._pickSquare(e.clientX, e.clientY, false);
    const canDragThis = Boolean(sq && this.canSelectSquare(sq));

    this.pointerState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      downSquare: sq,
      canDrag: canDragThis,
      isDragging: false,
      movedTooMuch: false,
      controlsLocked: false,
      wasAlreadySelected: Boolean(sq && sq === this.selectedSquare),
    };

    // Nếu nhấn trúng quân hợp lệ của mình, tạm khóa OrbitControls để kéo quân không làm xoay camera
    if (canDragThis) {
      this.controls.enabled = false;
      this.pointerState.controlsLocked = true;
    }
  }

  _handlePointerMove(e) {
    // Cập nhật con trỏ chuột khi hover trên desktop (không nhấn giữ)
    if (!this.pointerState) {
      if (this.enabled && e.pointerType === 'mouse') {
        const hoverSq = this._pickSquare(e.clientX, e.clientY, false);
        const interactive =
          hoverSq && (this.canSelectSquare(hoverSq) || this.legalTargetsSet.has(hoverSq));
        this.canvas.style.cursor = interactive ? 'pointer' : 'grab';
      }
      return;
    }

    if (e.pointerId !== this.pointerState.pointerId) return;

    const dx = e.clientX - this.pointerState.startX;
    const dy = e.clientY - this.pointerState.startY;
    const dist = Math.hypot(dx, dy);

    if (dist > DRAG_THRESHOLD_PX) {
      this.pointerState.movedTooMuch = true;

      // Bắt đầu chế độ kéo quân nếu nhấn trúng quân hợp lệ
      if (this.pointerState.canDrag && !this.pointerState.isDragging) {
        this.pointerState.isDragging = true;
        this.selectSquare(this.pointerState.downSquare);
        this.piecesManager.setDraggingSquare(this.pointerState.downSquare);
        this.canvas.style.cursor = 'grabbing';
      }
    }

    if (this.pointerState.isDragging) {
      const pt = this._raycastDragPlane(e.clientX, e.clientY);
      if (pt) {
        this.piecesManager.setDraggedPiecePosition(pt.x, DRAG_LIFT_Y, pt.z);
        const hoverSq = worldToSquare(pt.x, pt.z);
        this.highlights.setHover(hoverSq && this.legalTargetsSet.has(hoverSq) ? hoverSq : null);
      }
    }
  }

  _handlePointerUp(e) {
    this.activePointers.delete(e.pointerId);

    const state = this.pointerState;
    if (!state || e.pointerId !== state.pointerId) return;

    if (state.controlsLocked) {
      this.controls.enabled = true;
    }
    this.pointerState = null;
    this.canvas.style.cursor = 'default';

    if (!this.enabled) {
      this.piecesManager.setDraggingSquare(null);
      this.highlights.setHover(null);
      return;
    }

    // Trường hợp 1: Kết thúc kéo-thả quân
    if (state.isDragging) {
      const fromSq = state.downSquare;
      const pt = this._raycastDragPlane(e.clientX, e.clientY);
      const dropSq = pt ? worldToSquare(pt.x, pt.z) : null;

      this.piecesManager.setDraggingSquare(null);
      this.highlights.setHover(null);

      if (dropSq && dropSq !== fromSq) {
        if (this.legalTargetsSet.has(dropSq)) {
          this.clearSelection();
          this.onAttemptMove(fromSq, dropSq);
          return;
        }
        // Thả vào ô không hợp lệ -> rung nhẹ quân để phản hồi
        this.piecesManager.shakePiece(fromSq);
        if (this.onInvalidSquare) this.onInvalidSquare(fromSq, dropSq);
      }
      return;
    }

    // Trường hợp 2: Người dùng kéo xoay camera -> không xử lý như click
    if (state.movedTooMuch) return;

    // Trường hợp 3: Click / Chạm-chạm
    const clickedSq = this._pickSquare(e.clientX, e.clientY, false);

    if (!clickedSq) {
      this.clearSelection();
      return;
    }

    // Nếu đang có quân được chọn
    if (this.selectedSquare) {
      // Chạm đúng ô đích hợp lệ -> đi cờ
      if (this.legalTargetsSet.has(clickedSq)) {
        const fromSq = this.selectedSquare;
        this.clearSelection();
        this.onAttemptMove(fromSq, clickedSq);
        return;
      }

      // Chạm lại chính quân đang chọn -> bỏ chọn
      if (clickedSq === this.selectedSquare) {
        this.clearSelection();
        return;
      }

      // Chạm vào một quân hợp lệ khác của mình -> chuyển sang chọn quân đó
      if (this.canSelectSquare(clickedSq)) {
        this.selectSquare(clickedSq);
        return;
      }

      // Chạm vào ô không hợp lệ khi đang chọn quân -> phản hồi rung nhẹ
      this.piecesManager.shakePiece(this.selectedSquare);
      if (this.onInvalidSquare) this.onInvalidSquare(this.selectedSquare, clickedSq);
      return;
    }

    // Chưa chọn quân nào -> thử chọn quân tại ô vừa chạm
    if (this.canSelectSquare(clickedSq)) {
      this.selectSquare(clickedSq);
    }
  }

  _handlePointerCancel(e) {
    this.activePointers.delete(e.pointerId);
    if (this.pointerState && e.pointerId === this.pointerState.pointerId) {
      this._cancelDrag();
    }
  }

  dispose() {
    this._cancelDrag();
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerCancel);
  }
}

