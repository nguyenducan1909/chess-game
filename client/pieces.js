/**
 * Quản lý tải model GLB, chuẩn hóa hệ tọa độ bàn cờ 8x8,
 * trích xuất 12 bản mẫu quân cờ (6 loại x 2 màu) với pivot nằm ở đáy,
 * chia sẻ geometry/material bằng clone để tiết kiệm bộ nhớ,
 * và đặt 32 quân cờ đúng vị trí theo chuỗi FEN.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** FEN khai cuộc tiêu chuẩn của cờ vua */
export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Thông số lưới 8x8 đo trực tiếp từ mesh `Chess_board_Chess_board_0` ở Bước 0.
 * - Mặt trên bàn cờ ở y = 0.0368
 * - 8 ô theo X trải từ -0.77315 đến +0.77315 (rộng 1.5463)
 * - 8 ô theo Z trải từ -0.77030 đến +0.77400 (rộng 1.5443, tâm lệch +0.00185)
 */
const BOARD_GRID_MIN_X = -0.77315;
const BOARD_GRID_MAX_X = 0.77315;
const BOARD_GRID_MIN_Z = -0.7703;
const BOARD_GRID_MAX_Z = 0.774;
const BOARD_TOP_Y = 0.0368;

const BOARD_GRID_SIZE = ((BOARD_GRID_MAX_X - BOARD_GRID_MIN_X) + (BOARD_GRID_MAX_Z - BOARD_GRID_MIN_Z)) / 2;
const BOARD_GRID_CENTER_X = (BOARD_GRID_MIN_X + BOARD_GRID_MAX_X) / 2;
const BOARD_GRID_CENTER_Z = (BOARD_GRID_MIN_Z + BOARD_GRID_MAX_Z) / 2;

/** Hệ số phóng đại để vùng 8x8 có kích thước đúng 8.0 x 8.0 (mỗi ô 1.0 x 1.0 đơn vị) */
export const BOARD_SCALE = 8.0 / BOARD_GRID_SIZE;

/**
 * Bảng ánh xạ tên node Group trong `chess_set.glb` -> mẫu quân (color + type).
 * Đã được kiểm chứng và xác nhận ở Bước 0:
 *   Piece_01 = Tốt (p), Piece_02 = Xe (r), Piece_03 = Mã (n),
 *   Piece_04 = Tượng (b), Piece_05 = Hậu (q), Piece_06 = Vua (k)
 */
const PIECE_TEMPLATE_NODES = {
  w: {
    p: 'Piece_01',
    r: 'Piece_02',
    n: 'Piece_03',
    b: 'Piece_04',
    q: 'Piece_05',
    k: 'Piece_06',
  },
  b: {
    p: 'Piece_01.008',
    r: 'Piece_02.002',
    n: 'Piece_03.002',
    b: 'Piece_04.002',
    q: 'Piece_05.001',
    k: 'Piece_06.001',
  },
};

const FILES = 'abcdefgh';

/**
 * Chuyển tên ô cờ (vd: 'a1', 'e4') sang tọa độ world trên mặt bàn (y = 0).
 * Quy ước:
 * - Nhìn từ phía Trắng (+Z nhìn về -Z): a1 ở (-3.5, 0, +3.5) (ô tối), h1 ở (+3.5, 0, +3.5) (ô sáng).
 * @param {string} square
 * @returns {THREE.Vector3}
 */
export function squareToWorld(square) {
  const fileIdx = FILES.indexOf(square[0]);
  const rankNum = Number(square[1]);
  const x = fileIdx - 3.5;
  const z = 4.5 - rankNum;
  return new THREE.Vector3(x, 0, z);
}

/**
 * Chuyển tọa độ world (x, z) về tên ô cờ ('a1'..'h8'), hoặc null nếu ngoài lưới 8x8.
 * @param {number} x
 * @param {number} z
 * @returns {string | null}
 */
export function worldToSquare(x, z) {
  const fileIdx = Math.floor(x + 4);
  const rankNum = 8 - Math.floor(z + 4);
  if (fileIdx < 0 || fileIdx > 7 || rankNum < 1 || rankNum > 8) {
    return null;
  }
  return `${FILES[fileIdx]}${rankNum}`;
}

/** Nâng độ sắc nét texture khi nhìn ở góc nghiêng */
function enhanceMaterialTextures(material, maxAnisotropy) {
  const mats = Array.isArray(material) ? material : [material];
  for (const mat of mats) {
    if (!mat) continue;
    for (const key of ['map', 'roughnessMap', 'metalnessMap', 'normalMap', 'aoMap']) {
      const tex = mat[key];
      if (tex && tex.isTexture) {
        tex.anisotropy = Math.min(8, maxAnisotropy || 4);
        tex.needsUpdate = true;
      }
    }
  }
}

/**
 * Tìm node theo tên gốc trong GLB, có xử lý việc Three.js GLTFLoader
 * tự động sanitize tên node (xóa dấu '.' — vd: "Piece_01.008" -> "Piece_01008").
 */
function findGlbNode(rootScene, rawName) {
  const direct = rootScene.getObjectByName(rawName);
  if (direct) return direct;

  const sanitized = THREE.PropertyBinding.sanitizeNodeName(rawName);
  const bySanitized = rootScene.getObjectByName(sanitized);
  if (bySanitized) return bySanitized;

  const strippedTarget = rawName.replace(/\./g, '');
  let found = null;
  rootScene.traverse((obj) => {
    if (!found && obj.name && obj.name.replace(/\./g, '') === strippedTarget) {
      found = obj;
    }
  });
  return found;
}

/**
 * Trích xuất và chuẩn hóa bàn cờ từ node `Chess_board`.
 * Đưa mặt trên bàn cờ về y = 0, tâm lưới 8x8 về (0, 0), mỗi ô = 1.0 x 1.0 đơn vị.
 */
function extractNormalizedBoard(rootScene, usedGeometries, maxAnisotropy) {
  const boardSource = findGlbNode(rootScene, 'Chess_board');
  if (!boardSource) {
    throw new Error('Không tìm thấy node "Chess_board" trong file chess_set.glb');
  }

  const boardGroup = new THREE.Group();
  boardGroup.name = 'ChessBoard';

  // Ma trận đưa đỉnh từ world space của GLB sang hệ tọa độ game chuẩn
  const normalizeMatrix = new THREE.Matrix4()
    .makeScale(BOARD_SCALE, BOARD_SCALE, BOARD_SCALE)
    .multiply(
      new THREE.Matrix4().makeTranslation(
        -BOARD_GRID_CENTER_X,
        -BOARD_TOP_Y,
        -BOARD_GRID_CENTER_Z
      )
    );

  boardSource.traverse((child) => {
    if (!child.isMesh) return;
    let geometry = child.geometry;
    if (usedGeometries.has(geometry)) {
      geometry = geometry.clone();
    } else {
      usedGeometries.add(geometry);
    }

    const bakedMatrix = new THREE.Matrix4().multiplyMatrices(normalizeMatrix, child.matrixWorld);
    geometry.applyMatrix4(bakedMatrix);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    enhanceMaterialTextures(child.material, maxAnisotropy);

    const mesh = new THREE.Mesh(geometry, child.material);
    mesh.name = 'ChessBoardSurface';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData = { isBoard: true };
    boardGroup.add(mesh);
  });

  return boardGroup;
}

/**
 * Trích xuất và chuẩn hóa 1 bản mẫu quân cờ:
 * - Gộp toàn bộ mesh con (vd: Tượng có 3 mesh con) về world space và nhân BOARD_SCALE
 * - Đặt pivot chính xác ở đáy (min.y = 0) và tâm phần đế ở (x = 0, z = 0)
 * - Xoay quân Mã 180 độ quanh trục Y để đầu ngựa hướng thẳng về phía đối thủ
 */
function extractPieceTemplate(rootScene, nodeName, color, type, usedGeometries, maxAnisotropy) {
  const sourceGroup = findGlbNode(rootScene, nodeName);
  if (!sourceGroup) {
    throw new Error(`Không tìm thấy node quân cờ "${nodeName}" (${color}_${type}) trong chess_set.glb`);
  }

  const scaleMatrix = new THREE.Matrix4().makeScale(BOARD_SCALE, BOARD_SCALE, BOARD_SCALE);
  const extractedParts = [];
  const overallBox = new THREE.Box3();

  // Bước 1: Bake world transform + scale cho tất cả mesh con của quân cờ
  sourceGroup.traverse((child) => {
    if (!child.isMesh) return;
    let geometry = child.geometry;
    if (usedGeometries.has(geometry)) {
      geometry = geometry.clone();
    } else {
      usedGeometries.add(geometry);
    }

    const bakedMatrix = new THREE.Matrix4().multiplyMatrices(scaleMatrix, child.matrixWorld);
    geometry.applyMatrix4(bakedMatrix);
    geometry.computeBoundingBox();
    overallBox.union(geometry.boundingBox);

    enhanceMaterialTextures(child.material, maxAnisotropy);
    extractedParts.push({ geometry, material: child.material });
  });

  if (extractedParts.length === 0) {
    throw new Error(`Node "${nodeName}" không có mesh nào.`);
  }

  // Bước 2: Tính tâm (centerX, centerZ) và đáy (minY)
  const minY = overallBox.min.y;
  const height = overallBox.max.y - minY;
  let centerX = (overallBox.min.x + overallBox.max.x) / 2;
  let centerZ = (overallBox.min.z + overallBox.max.z) / 2;

  // Với quân Mã (n), đầu ngựa nhô về trước nên ta tính tâm theo 15% chiều cao phần đế tròn
  if (type === 'n') {
    const baseThresholdY = minY + height * 0.15;
    let baseMinX = Infinity;
    let baseMaxX = -Infinity;
    let baseMinZ = Infinity;
    let baseMaxZ = -Infinity;
    let foundBase = false;

    for (const part of extractedParts) {
      const posAttr = part.geometry.getAttribute('position');
      if (!posAttr) continue;
      for (let i = 0; i < posAttr.count; i++) {
        const y = posAttr.getY(i);
        if (y <= baseThresholdY) {
          const x = posAttr.getX(i);
          const z = posAttr.getZ(i);
          if (x < baseMinX) baseMinX = x;
          if (x > baseMaxX) baseMaxX = x;
          if (z < baseMinZ) baseMinZ = z;
          if (z > baseMaxZ) baseMaxZ = z;
          foundBase = true;
        }
      }
    }

    if (foundBase) {
      centerX = (baseMinX + baseMaxX) / 2;
      centerZ = (baseMinZ + baseMaxZ) / 2;
    }
  }

  // Bước 3: Dịch chuyển geometry về gốc (0, 0, 0) tại đáy đế; xoay Mã 180 độ hướng về đối thủ
  const recenterMatrix = new THREE.Matrix4().makeTranslation(-centerX, -minY, -centerZ);
  if (type === 'n') {
    recenterMatrix.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
  }

  const templateGroup = new THREE.Group();
  templateGroup.name = `Template_${color}_${type}`;

  const finalBox = new THREE.Box3();
  for (const part of extractedParts) {
    part.geometry.applyMatrix4(recenterMatrix);
    part.geometry.computeBoundingBox();
    part.geometry.computeBoundingSphere();
    finalBox.union(part.geometry.boundingBox);

    const mesh = new THREE.Mesh(part.geometry, part.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    templateGroup.add(mesh);
  }

  // Lưu kích thước hộp va chạm gọn (AABB) để Raycaster bắt quân siêu nhanh, tránh duyệt mesh high-poly
  const finalSize = new THREE.Vector3();
  finalBox.getSize(finalSize);
  templateGroup.userData.hitHalfW = Math.min(0.44, Math.max(0.28, Math.max(finalSize.x, finalSize.z) * 0.52));
  templateGroup.userData.hitHeight = Math.max(0.8, finalSize.y);

  return templateGroup;
}

/**
 * Tải model GLB một lần duy nhất, chuẩn hóa bàn cờ + 12 bản mẫu quân cờ,
 * đồng thời giải phóng geometry thừa của các bản sao dư trong file GLB gốc.
 * @param {string} modelUrl
 * @param {{ onProgress?: (info: { loaded: number, total: number, percent: number | null }) => void, maxAnisotropy?: number }} options
 */
export async function loadChessAssets(modelUrl = '/models/chess_set.glb', options = {}) {
  const { onProgress, maxAnisotropy = 4 } = options;
  const loader = new GLTFLoader();

  const gltf = await new Promise((resolve, reject) => {
    loader.load(
      modelUrl,
      (result) => resolve(result),
      (event) => {
        if (!onProgress) return;
        const total = event.total || 0;
        const percent = total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : null;
        onProgress({ loaded: event.loaded, total, percent });
      },
      (error) => reject(error)
    );
  });

  gltf.scene.updateMatrixWorld(true);

  const usedGeometries = new Set();
  const usedMaterials = new Set();

  // Trích bàn cờ chuẩn hóa
  const board = extractNormalizedBoard(gltf.scene, usedGeometries, maxAnisotropy);
  board.traverse((child) => {
    if (child.isMesh && child.material) {
      usedMaterials.add(child.material);
    }
  });

  // Trích 12 bản mẫu quân cờ (6 loại x 2 màu)
  const templates = new Map();
  for (const color of ['w', 'b']) {
    for (const [type, nodeName] of Object.entries(PIECE_TEMPLATE_NODES[color])) {
      const key = `${color}_${type}`;
      const tpl = extractPieceTemplate(gltf.scene, nodeName, color, type, usedGeometries, maxAnisotropy);
      tpl.traverse((child) => {
        if (child.isMesh && child.material) {
          usedMaterials.add(child.material);
        }
      });
      templates.set(key, tpl);
    }
  }

  // Giải phóng ngay các geometry dư thừa (20 quân cờ không dùng làm mẫu, gồm 2 quân Tượng ~700k tam giác)
  let disposedGeoCount = 0;
  gltf.scene.traverse((child) => {
    if (child.isMesh && child.geometry && !usedGeometries.has(child.geometry)) {
      child.geometry.dispose();
      disposedGeoCount++;
    }
  });

  /** Tạo bản sao quân cờ dùng chung geometry và material (không nhân bản dữ liệu GPU) */
  function createPieceInstance(color, type) {
    const template = templates.get(`${color}_${type}`);
    if (!template) {
      throw new Error(`Không có bản mẫu quân cờ cho "${color}_${type}"`);
    }
    const piece = template.clone(true);
    piece.name = `Piece_${color}_${type}`;
    piece.userData = {
      isPiece: true,
      color,
      type,
      square: null,
      hitHalfW: template.userData.hitHalfW ?? 0.35,
      hitHeight: template.userData.hitHeight ?? 1.2,
    };
    piece.traverse((child) => {
      if (child.isMesh) {
        child.userData = { isPieceMesh: true, pieceRoot: piece };
      }
    });
    return piece;
  }

  /** Giải phóng toàn bộ tài nguyên GPU khi hủy game */
  function dispose() {
    for (const geo of usedGeometries) {
      geo.dispose();
    }
    for (const mat of usedMaterials) {
      for (const key of ['map', 'roughnessMap', 'metalnessMap', 'normalMap', 'aoMap']) {
        mat[key]?.dispose?.();
      }
      mat.dispose();
    }
    usedGeometries.clear();
    usedMaterials.clear();
    templates.clear();
  }

  return {
    board,
    templates,
    createPieceInstance,
    disposedGeoCount,
    dispose,
  };
}

/**
 * Phân tích phần vị trí quân của chuỗi FEN thành danh sách { square, color, type }.
 * (Cho phép đặt quân ở Giai đoạn 2 mà chưa cần phụ thuộc chess.js; sang Giai đoạn 3 vẫn đồng bộ chuẩn theo FEN)
 */
export function parseFenPlacement(fen) {
  const placement = fen.trim().split(/\s+/)[0];
  const rows = placement.split('/');
  if (rows.length !== 8) {
    throw new Error(`Chuỗi FEN không hợp lệ: ${fen}`);
  }

  const pieces = [];
  for (let r = 0; r < 8; r++) {
    const rankNum = 8 - r;
    let fileIdx = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') {
        fileIdx += Number(ch);
      } else {
        const isWhite = ch === ch.toUpperCase();
        const color = isWhite ? 'w' : 'b';
        const type = ch.toLowerCase();
        const square = `${FILES[fileIdx]}${rankNum}`;
        pieces.push({ square, color, type });
        fileIdx += 1;
      }
    }
  }
  return pieces;
}

/**
 * Quản lý tập hợp các quân cờ đang hiển thị trên bàn 3D.
 */
export class BoardPiecesManager {
  /**
   * @param {THREE.Scene} scene
   * @param {Awaited<ReturnType<typeof loadChessAssets>>} assets
   */
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.piecesGroup = new THREE.Group();
    this.piecesGroup.name = 'ChessPieces';
    this.scene.add(this.piecesGroup);

    /** @type {Map<string, THREE.Group>} Bản đồ square ('e2') -> Object3D quân cờ */
    this.bySquare = new Map();
    /** @type {string | null} Ô đang được chọn (để nhấc nhẹ quân) */
    this.selectedSquare = null;
    /** @type {string | null} Ô có quân đang được kéo thả */
    this.draggingSquare = null;
    /** @type {{ square: string, elapsed: number, duration: number } | null} Hiệu ứng rung nhẹ khi nước đi không hợp lệ */
    this.shakeState = null;

    /** Danh sách animation di chuyển quân đang chạy */
    this.moveAnimations = [];
    /** Danh sách animation quân bị bắt (thu nhỏ & mờ dần) */
    this.captureAnimations = [];
    /** Danh sách animation nở nhẹ khi phong cấp */
    this.popAnimations = [];
    /** Chuỗi FEN chuẩn cần đối chiếu lại sau khi animation kết thúc */
    this.pendingFen = null;
  }

  /** Hủy và dọn sạch các animation đang chạy (giải phóng material tạm của quân bị bắt) */
  _clearAnimations() {
    for (const anim of this.captureAnimations) {
      this.piecesGroup.remove(anim.piece);
      for (const mat of anim.clonedMaterials) {
        mat.dispose();
      }
    }
    this.captureAnimations = [];
    this.moveAnimations = [];
    this.popAnimations = [];
    this.pendingFen = null;
  }

  /** Xóa toàn bộ quân hiện tại trên bàn (chỉ gỡ khỏi scene, giữ nguyên geometry/material dùng chung) */
  clear() {
    this._clearAnimations();
    for (const piece of this.bySquare.values()) {
      this.piecesGroup.remove(piece);
    }
    this.bySquare.clear();
    this.selectedSquare = null;
    this.draggingSquare = null;
    this.shakeState = null;
  }

  /** Đồng bộ lại toàn bộ quân trên bàn ngay lập tức theo chuỗi FEN */
  syncFromFen(fen = INITIAL_FEN) {
    this.clear();
    const list = parseFenPlacement(fen);
    for (const item of list) {
      const piece = this.assets.createPieceInstance(item.color, item.type);
      const pos = squareToWorld(item.square);
      piece.position.copy(pos);
      piece.userData.square = item.square;
      this.piecesGroup.add(piece);
      this.bySquare.set(item.square, piece);
    }
    return list.length;
  }

  /**
   * Tạo hiệu ứng thu nhỏ + mờ dần cho quân bị bắt mà không ảnh hưởng tới các quân dùng chung material.
   */
  _startCaptureAnimation(piece) {
    const clonedMaterials = [];
    piece.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      if (Array.isArray(child.material)) {
        const arr = child.material.map((m) => {
          const clone = m.clone();
          clone.transparent = true;
          clone.depthWrite = false;
          clonedMaterials.push(clone);
          return clone;
        });
        child.material = arr;
      } else {
        const clone = child.material.clone();
        clone.transparent = true;
        clone.depthWrite = false;
        clonedMaterials.push(clone);
        child.material = clone;
      }
      child.castShadow = false;
    });

    this.captureAnimations.push({
      piece,
      clonedMaterials,
      startY: piece.position.y,
      elapsed: 0,
      duration: 0.28,
    });
  }

  /**
   * Chạy animation mượt cho một nước đi (đường cong parabola, Mã nhảy cao hơn,
   * nhập thành di chuyển cả Vua và Xe, quân bị bắt thu nhỏ/mờ dần, phong cấp nở nhẹ),
   * sau đó đảm bảo khớp tuyệt đối với `finalFen`.
   * @param {{ from: string, to: string, piece?: string, color?: string, flags?: string, promotion?: string | null }} move
   * @param {string} finalFen
   */
  animateMove(move, finalFen) {
    if (!move || !move.from || !move.to) {
      this.syncFromFen(finalFen);
      return;
    }

    // Nếu nước trước còn animation dang dở, chốt ngay về trạng thái cuối trước khi chạy nước mới
    if (this.moveAnimations.length > 0 && this.pendingFen) {
      const prevFen = this.pendingFen;
      this.syncFromFen(prevFen);
    } else if (this.captureAnimations.length > 0 || this.popAnimations.length > 0) {
      // Giữ các capture cũ hoàn tất gọn nếu không trùng, nhưng reset pop
      this.popAnimations = [];
    }

    const movingPiece = this.bySquare.get(move.from);
    if (!movingPiece) {
      this.syncFromFen(finalFen);
      return;
    }

    this.selectedSquare = null;
    this.draggingSquare = null;
    this.shakeState = null;

    const flags = move.flags || '';

    // 1. Xử lý quân bị bắt (cả bắt thường và bắt tốt qua đường en passant 'e')
    const capturedSquare = flags.includes('e')
      ? `${move.to[0]}${move.from[1]}`
      : move.to;

    const capturedPiece = this.bySquare.get(capturedSquare);
    if (capturedPiece && capturedPiece !== movingPiece) {
      this.bySquare.delete(capturedSquare);
      this._startCaptureAnimation(capturedPiece);
    }

    // 2. Animation cho quân di chuyển chính (Mã nhảy cao hơn hẳn các quân khác)
    this.bySquare.delete(move.from);
    movingPiece.userData.square = move.to;
    this.bySquare.set(move.to, movingPiece);

    const isKnight = (move.piece || movingPiece.userData.type) === 'n';
    const endPos = squareToWorld(move.to);

    this.moveAnimations.push({
      piece: movingPiece,
      startPos: movingPiece.position.clone(),
      endPos,
      arcHeight: isKnight ? 1.28 : 0.44,
      elapsed: 0,
      duration: isKnight ? 0.34 : 0.27,
      finalSquare: move.to,
      replacePromotion: move.promotion
        ? { color: move.color || movingPiece.userData.color, type: move.promotion }
        : null,
    });

    // 3. Nhập thành: di chuyển đồng thời cả Xe nhảy nhẹ sang ô đích
    if (flags.includes('k') || flags.includes('q')) {
      const color = move.color || movingPiece.userData.color;
      const rank = color === 'w' ? '1' : '8';
      const rookFrom = flags.includes('k') ? `h${rank}` : `a${rank}`;
      const rookTo = flags.includes('k') ? `f${rank}` : `d${rank}`;
      const rookPiece = this.bySquare.get(rookFrom);
      if (rookPiece) {
        this.bySquare.delete(rookFrom);
        rookPiece.userData.square = rookTo;
        this.bySquare.set(rookTo, rookPiece);
        this.moveAnimations.push({
          piece: rookPiece,
          startPos: rookPiece.position.clone(),
          endPos: squareToWorld(rookTo),
          arcHeight: 0.68,
          elapsed: 0,
          duration: 0.32,
          finalSquare: rookTo,
          replacePromotion: null,
        });
      }
    }

    this.pendingFen = finalFen;
  }

  /** Kiểm tra bàn hiện tại đã khớp hoàn toàn với FEN chưa (phòng sai lệch trạng thái) */
  _verifyMatchesFen(fen) {
    const expected = parseFenPlacement(fen);
    if (expected.length !== this.bySquare.size) return false;
    for (const item of expected) {
      const piece = this.bySquare.get(item.square);
      if (!piece || piece.userData.color !== item.color || piece.userData.type !== item.type) {
        return false;
      }
    }
    return true;
  }

  /** Đánh dấu ô đang chọn để nhấc nhẹ quân cờ lên */
  setSelectedSquare(square) {
    this.selectedSquare = square || null;
  }

  /** Bắt đầu / kết thúc kéo quân tự do theo con trỏ */
  setDraggingSquare(square) {
    if (this.draggingSquare && this.draggingSquare !== square) {
      const prev = this.bySquare.get(this.draggingSquare);
      if (prev) {
        const home = squareToWorld(this.draggingSquare);
        prev.position.x = home.x;
        prev.position.z = home.z;
      }
    }
    this.draggingSquare = square || null;
  }

  /** Di chuyển quân đang kéo tới vị trí world (x, y, z) */
  setDraggedPiecePosition(x, y, z) {
    if (!this.draggingSquare) return;
    const piece = this.bySquare.get(this.draggingSquare);
    if (piece) {
      piece.position.set(x, y, z);
    }
  }

  /** Kích hoạt hiệu ứng rung nhẹ khi người chơi thử nước đi không hợp lệ */
  shakePiece(square) {
    if (!square || !this.bySquare.has(square)) return;
    this.shakeState = { square, elapsed: 0, duration: 0.32 };
  }

  /** Cập nhật mỗi khung hình: animation di chuyển đường cong, bắt quân, phong cấp, nhấc chọn và rung */
  update(dt) {
    const animatingSquares = new Set();

    // 1. Cập nhật animation di chuyển quân theo đường cong
    if (this.moveAnimations.length > 0) {
      const remaining = [];
      for (const anim of this.moveAnimations) {
        anim.elapsed += dt;
        const rawT = Math.min(1, anim.elapsed / anim.duration);
        // Easing smoothstep / cubic ease-in-out
        const eased = rawT < 0.5 ? 4 * rawT * rawT * rawT : 1 - Math.pow(-2 * rawT + 2, 3) / 2;

        const x = THREE.MathUtils.lerp(anim.startPos.x, anim.endPos.x, eased);
        const z = THREE.MathUtils.lerp(anim.startPos.z, anim.endPos.z, eased);
        const baseY = THREE.MathUtils.lerp(anim.startPos.y, anim.endPos.y, eased);
        const arcY = Math.sin(rawT * Math.PI) * anim.arcHeight;
        anim.piece.position.set(x, baseY + arcY, z);

        if (rawT < 1) {
          animatingSquares.add(anim.finalSquare);
          remaining.push(anim);
        } else {
          anim.piece.position.copy(anim.endPos);

          // Nếu là nước phong cấp -> thay Tốt bằng quân phong cấp kèm hiệu ứng nở nhẹ
          if (anim.replacePromotion) {
            const { color, type } = anim.replacePromotion;
            this.piecesGroup.remove(anim.piece);
            const promoted = this.assets.createPieceInstance(color, type);
            promoted.position.copy(anim.endPos);
            promoted.userData.square = anim.finalSquare;
            promoted.scale.setScalar(0.55);
            this.piecesGroup.add(promoted);
            this.bySquare.set(anim.finalSquare, promoted);
            this.popAnimations.push({ piece: promoted, elapsed: 0, duration: 0.22 });
          }
        }
      }

      this.moveAnimations = remaining;

      // Khi mọi chuyển động đã xong, đối chiếu lại với FEN chuẩn của server
      if (this.moveAnimations.length === 0 && this.pendingFen) {
        const fenToCheck = this.pendingFen;
        this.pendingFen = null;
        if (!this._verifyMatchesFen(fenToCheck)) {
          this.syncFromFen(fenToCheck);
        }
      }
    }

    // 2. Cập nhật hiệu ứng quân bị bắt (thu nhỏ + mờ dần + nâng nhẹ)
    if (this.captureAnimations.length > 0) {
      const remainingCap = [];
      for (const anim of this.captureAnimations) {
        anim.elapsed += dt;
        const t = Math.min(1, anim.elapsed / anim.duration);
        const eased = 1 - Math.pow(1 - t, 2);

        const scale = Math.max(0.08, 1 - eased * 0.88);
        anim.piece.scale.setScalar(scale);
        anim.piece.position.y = anim.startY + eased * 0.35;
        anim.piece.rotation.y += dt * 4.5;

        const opacity = Math.max(0, 1 - eased);
        for (const mat of anim.clonedMaterials) {
          mat.opacity = opacity;
        }

        if (t < 1) {
          remainingCap.push(anim);
        } else {
          this.piecesGroup.remove(anim.piece);
          for (const mat of anim.clonedMaterials) {
            mat.dispose();
          }
        }
      }
      this.captureAnimations = remainingCap;
    }

    // 3. Cập nhật hiệu ứng nở nhẹ cho quân mới phong cấp
    if (this.popAnimations.length > 0) {
      const remainingPop = [];
      for (const anim of this.popAnimations) {
        anim.elapsed += dt;
        const t = Math.min(1, anim.elapsed / anim.duration);
        // Overshoot nhẹ rồi về 1.0
        const s = t < 0.7 ? THREE.MathUtils.lerp(0.55, 1.08, t / 0.7) : THREE.MathUtils.lerp(1.08, 1.0, (t - 0.7) / 0.3);
        anim.piece.scale.setScalar(s);
        if (t < 1) {
          remainingPop.push(anim);
        } else {
          anim.piece.scale.setScalar(1);
        }
      }
      this.popAnimations = remainingPop;
    }

    // 4. Nhấc/hạ quân đang chọn và hiệu ứng rung
    const liftSpeed = Math.min(1, dt * 16);
    for (const [sq, piece] of this.bySquare.entries()) {
      if (sq === this.draggingSquare || animatingSquares.has(sq)) continue;

      const home = squareToWorld(sq);
      const targetY = sq === this.selectedSquare ? 0.28 : 0;
      piece.position.y += (targetY - piece.position.y) * liftSpeed;

      if (!this.shakeState || this.shakeState.square !== sq) {
        piece.position.x += (home.x - piece.position.x) * liftSpeed;
        piece.position.z += (home.z - piece.position.z) * liftSpeed;
      }
    }

    if (this.shakeState) {
      this.shakeState.elapsed += dt;
      const piece = this.bySquare.get(this.shakeState.square);
      if (piece && !animatingSquares.has(this.shakeState.square)) {
        const home = squareToWorld(this.shakeState.square);
        const progress = Math.min(1, this.shakeState.elapsed / this.shakeState.duration);
        const decay = 1 - progress;
        const offset = Math.sin(progress * Math.PI * 6) * 0.12 * decay;
        piece.position.x = home.x + offset;
        piece.position.z = home.z;
        if (progress >= 1) {
          piece.position.x = home.x;
          this.shakeState = null;
        }
      } else {
        this.shakeState = null;
      }
    }
  }

  getPieceAt(square) {
    return this.bySquare.get(square) || null;
  }

  getAllPieces() {
    return [...this.bySquare.values()];
  }

  dispose() {
    this.clear();
    this.scene.remove(this.piecesGroup);
  }
}

/**
 * Quản lý tất cả hiệu ứng tô sáng trên mặt bàn cờ:
 * - Ô đang chọn
 * - Các ô đi hợp lệ (chấm tròn) và ô có thể bắt quân (vòng tròn đỏ/cam)
 * - Ô đang di chuột/kéo qua (hover)
 * - Nước đi cuối cùng (from -> to)
 * - Ô Vua đang bị chiếu (nhấp nháy đỏ)
 */
export class BoardHighlights {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'BoardHighlights';
    this.scene.add(this.group);

    // Geometry dùng chung để tiết kiệm bộ nhớ
    this.squareGeo = new THREE.PlaneGeometry(0.96, 0.96);
    this.squareGeo.rotateX(-Math.PI / 2);

    this.moveDotGeo = new THREE.CircleGeometry(0.17, 28);
    this.moveDotGeo.rotateX(-Math.PI / 2);

    this.captureRingGeo = new THREE.RingGeometry(0.32, 0.45, 36);
    this.captureRingGeo.rotateX(-Math.PI / 2);

    this.checkRingGeo = new THREE.RingGeometry(0.28, 0.47, 36);
    this.checkRingGeo.rotateX(-Math.PI / 2);

    // Material riêng theo loại highlight
    this.selectedMat = new THREE.MeshBasicMaterial({
      color: 0xf5c542,
      transparent: true,
      opacity: 0.46,
      depthWrite: false,
    });

    this.lastMoveMat = new THREE.MeshBasicMaterial({
      color: 0xd9c25b,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });

    this.hoverMat = new THREE.MeshBasicMaterial({
      color: 0x6ce5b1,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });

    this.moveDotMat = new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });

    this.captureRingMat = new THREE.MeshBasicMaterial({
      color: 0xf43f5e,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });

    this.checkSquareMat = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });

    this.checkRingMat = new THREE.MeshBasicMaterial({
      color: 0xff5a5a,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });

    // Các mesh cố định (chỉ ẩn/hiện và đổi vị trí, không tạo mới liên tục)
    this.selectedMesh = this._makeFlatMesh(this.squareGeo, this.selectedMat, 0.008);
    this.hoverMesh = this._makeFlatMesh(this.squareGeo, this.hoverMat, 0.011);
    this.lastFromMesh = this._makeFlatMesh(this.squareGeo, this.lastMoveMat, 0.004);
    this.lastToMesh = this._makeFlatMesh(this.squareGeo, this.lastMoveMat, 0.004);
    this.checkSquareMesh = this._makeFlatMesh(this.squareGeo, this.checkSquareMat, 0.007);
    this.checkRingMesh = this._makeFlatMesh(this.checkRingGeo, this.checkRingMat, 0.013);

    this.legalGroup = new THREE.Group();
    this.group.add(this.legalGroup);

    this.pulseClock = 0;
    /** Danh sách sóng vòng sáng lan tỏa khi chiếu hoặc chiếu hết */
    this.ripples = [];
  }

  _makeFlatMesh(geometry, material, y) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = y;
    mesh.visible = false;
    mesh.renderOrder = 2;
    this.group.add(mesh);
    return mesh;
  }

  _placeOnSquare(mesh, square, y) {
    if (!square) {
      mesh.visible = false;
      return;
    }
    const pos = squareToWorld(square);
    mesh.position.set(pos.x, y, pos.z);
    mesh.visible = true;
  }

  /** Tô sáng ô đang chọn */
  setSelected(square) {
    this._placeOnSquare(this.selectedMesh, square, 0.008);
  }

  /** Tô sáng ô đang kéo quân đi qua */
  setHover(square) {
    this._placeOnSquare(this.hoverMesh, square, 0.011);
  }

  /** Tô sáng 2 ô của nước đi cuối cùng */
  setLastMove(from, to) {
    this._placeOnSquare(this.lastFromMesh, from, 0.004);
    this._placeOnSquare(this.lastToMesh, to, 0.004);
  }

  /** Tô sáng ô Vua khi đang bị chiếu */
  setCheckSquare(square) {
    this._placeOnSquare(this.checkSquareMesh, square, 0.007);
    this._placeOnSquare(this.checkRingMesh, square, 0.013);
  }

  /**
   * Hiển thị các nước đi hợp lệ từ ô đang chọn.
   * @param {Array<{ to: string, isCapture: boolean }>} targets
   */
  setLegalTargets(targets = []) {
    while (this.legalGroup.children.length > 0) {
      this.legalGroup.remove(this.legalGroup.children[0]);
    }

    for (const target of targets) {
      const pos = squareToWorld(target.to);
      const mesh = new THREE.Mesh(
        target.isCapture ? this.captureRingGeo : this.moveDotGeo,
        target.isCapture ? this.captureRingMat : this.moveDotMat
      );
      mesh.position.set(pos.x, 0.014, pos.z);
      mesh.renderOrder = 3;
      this.legalGroup.add(mesh);
    }
  }

  /** Kích hoạt hiệu ứng sóng sáng lan tỏa quanh ô Vua khi chiếu / chiếu hết */
  triggerCheckEffect(kingSquare, isCheckmate = false) {
    if (!kingSquare) return;
    const pos = squareToWorld(kingSquare);
    const waveCount = isCheckmate ? 2 : 1;

    for (let i = 0; i < waveCount; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: isCheckmate ? (i === 0 ? 0xff4444 : 0xf5c542) : 0xff5a5a,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.checkRingGeo, mat);
      mesh.position.set(pos.x, 0.018 + i * 0.002, pos.z);
      mesh.scale.set(0.5, 1, 0.5);
      mesh.renderOrder = 4;
      mesh.visible = i === 0;
      this.group.add(mesh);

      this.ripples.push({
        mesh,
        mat,
        delay: i * 0.16,
        elapsed: 0,
        duration: isCheckmate ? 0.72 : 0.52,
        maxScale: isCheckmate ? 3.2 : 2.3,
      });
    }
  }

  /** Xóa toàn bộ highlight chọn quân */
  clearSelection() {
    this.setSelected(null);
    this.setHover(null);
    this.setLegalTargets([]);
  }

  /** Xóa toàn bộ highlight trên bàn */
  clearAll() {
    this.clearSelection();
    this.setLastMove(null, null);
    this.setCheckSquare(null);
    for (const r of this.ripples) {
      this.group.remove(r.mesh);
      r.mat.dispose();
    }
    this.ripples = [];
  }

  /** Hiệu ứng nhấp nháy nhẹ cho ô Vua bị chiếu + sóng lan tỏa khi chiếu/chiếu hết */
  update(dt) {
    if (this.checkSquareMesh.visible) {
      this.pulseClock += dt * 4.5;
      const wave = (Math.sin(this.pulseClock) + 1) / 2;
      this.checkSquareMat.opacity = 0.32 + wave * 0.35;
      this.checkRingMat.opacity = 0.65 + wave * 0.35;
      const scale = 0.95 + wave * 0.08;
      this.checkRingMesh.scale.set(scale, 1, scale);
    }

    if (this.ripples.length > 0) {
      const next = [];
      for (const r of this.ripples) {
        if (r.delay > 0) {
          r.delay -= dt;
          if (r.delay <= 0) r.mesh.visible = true;
          next.push(r);
          continue;
        }
        r.elapsed += dt;
        const t = Math.min(1, r.elapsed / r.duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const s = THREE.MathUtils.lerp(0.5, r.maxScale, eased);
        r.mesh.scale.set(s, 1, s);
        r.mat.opacity = Math.max(0, 0.9 * (1 - eased));
        if (t < 1) {
          next.push(r);
        } else {
          this.group.remove(r.mesh);
          r.mat.dispose();
        }
      }
      this.ripples = next;
    }
  }

  dispose() {
    this.clearAll();
    this.scene.remove(this.group);
    this.squareGeo.dispose();
    this.moveDotGeo.dispose();
    this.captureRingGeo.dispose();
    this.checkRingGeo.dispose();
    this.selectedMat.dispose();
    this.lastMoveMat.dispose();
    this.hoverMat.dispose();
    this.moveDotMat.dispose();
    this.captureRingMat.dispose();
    this.checkSquareMat.dispose();
    this.checkRingMat.dispose();
  }
}

