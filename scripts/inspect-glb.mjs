/**
 * Script kiểm tra cấu trúc file 3D GLB (Bước 0).
 * Đọc cây node, mesh, material, texture, transform cục bộ,
 * bounding box theo hệ tọa độ thế giới (world space), đơn vị và hướng trục.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultModelPath = path.resolve(__dirname, '../public/models/chess_set.glb');
const modelPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultModelPath;

/** Định dạng số gọn gàng */
function fmt(n, digits = 4) {
  if (!Number.isFinite(n)) return 'NaN';
  const rounded = Number(n.toFixed(digits));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Định dạng vector 3 phần tử */
function fmtVec3(v, digits = 3) {
  return `[${fmt(v[0], digits)}, ${fmt(v[1], digits)}, ${fmt(v[2], digits)}]`;
}

/** Chuyển quaternion [x, y, z, w] sang góc Euler [rx, ry, rz] (độ, thứ tự XYZ) */
function quatToEulerDeg([x, y, z, w]) {
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const rx = Math.atan2(sinrCosp, cosrCosp);

  const sinp = 2 * (w * y - z * x);
  const ry = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);

  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const rz = Math.atan2(sinyCosp, cosyCosp);

  const toDeg = 180 / Math.PI;
  return [rx * toDeg, ry * toDeg, rz * toDeg];
}

/** Tạo bounding box rỗng */
function createEmptyBox() {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    empty: true,
  };
}

/** Mở rộng bounding box với một điểm 3D */
function expandBoxByPoint(box, x, y, z) {
  box.empty = false;
  if (x < box.min[0]) box.min[0] = x;
  if (y < box.min[1]) box.min[1] = y;
  if (z < box.min[2]) box.min[2] = z;
  if (x > box.max[0]) box.max[0] = x;
  if (y > box.max[1]) box.max[1] = y;
  if (z > box.max[2]) box.max[2] = z;
}

/** Gộp box B vào box A */
function mergeBox(target, source) {
  if (source.empty) return;
  expandBoxByPoint(target, source.min[0], source.min[1], source.min[2]);
  expandBoxByPoint(target, source.max[0], source.max[1], source.max[2]);
}

/** Tính kích thước và tâm của bounding box */
function getBoxMetrics(box) {
  if (box.empty) return null;
  const size = [
    box.max[0] - box.min[0],
    box.max[1] - box.min[1],
    box.max[2] - box.min[2],
  ];
  const center = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  return { min: box.min, max: box.max, size, center };
}

/**
 * Tính world bounding box cho mesh gắn trên một node
 * bằng cách biến đổi toàn bộ đỉnh (POSITION) qua ma trận world của node.
 */
function computeNodeMeshStats(node) {
  const mesh = node.getMesh();
  const box = createEmptyBox();
  if (!mesh) {
    return { box, vertices: 0, triangles: 0, primitives: 0, materials: [] };
  }

  const m = node.getWorldMatrix();
  const primitives = mesh.listPrimitives();
  const matNames = new Set();
  let vertices = 0;
  let triangles = 0;
  const pos = [0, 0, 0];

  for (const prim of primitives) {
    const mat = prim.getMaterial();
    matNames.add(mat ? (mat.getName() || '(unnamed-material)') : '(no-material)');

    const posAccessor = prim.getAttribute('POSITION');
    if (posAccessor) {
      const count = posAccessor.getCount();
      vertices += count;
      for (let i = 0; i < count; i++) {
        posAccessor.getElement(i, pos);
        const wx = m[0] * pos[0] + m[4] * pos[1] + m[8] * pos[2] + m[12];
        const wy = m[1] * pos[0] + m[5] * pos[1] + m[9] * pos[2] + m[13];
        const wz = m[2] * pos[0] + m[6] * pos[1] + m[10] * pos[2] + m[14];
        expandBoxByPoint(box, wx, wy, wz);
      }
    }

    const indices = prim.getIndices();
    if (indices) {
      triangles += Math.floor(indices.getCount() / 3);
    } else if (posAccessor) {
      triangles += Math.floor(posAccessor.getCount() / 3);
    }
  }

  return {
    box,
    vertices,
    triangles,
    primitives: primitives.length,
    materials: [...matNames],
  };
}

/** Đọc nhanh chunk JSON đầu tiên trong GLB để kiểm tra asset metadata & extensions */
function readGlbJsonHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(20);
    fs.readSync(fd, header, 0, 20, 0);
    const magic = header.toString('utf8', 0, 4);
    if (magic !== 'glTF') {
      throw new Error(`Không phải file GLB hợp lệ (magic=${magic})`);
    }
    const version = header.readUInt32LE(4);
    const jsonChunkLength = header.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonChunkLength);
    fs.readSync(fd, jsonBuf, 0, jsonChunkLength, 20);
    const json = JSON.parse(jsonBuf.toString('utf8'));
    return {
      version,
      asset: json.asset || {},
      extensionsUsed: json.extensionsUsed || [],
      extensionsRequired: json.extensionsRequired || [],
    };
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  if (!fs.existsSync(modelPath)) {
    console.error(`Không tìm thấy file model tại: ${modelPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(modelPath);
  const headerInfo = readGlbJsonHeader(modelPath);

  console.log('============================================================');
  console.log('BÁO CÁO KIỂM TRA FILE GLB (BƯỚC 0)');
  console.log('============================================================');
  console.log(`Đường dẫn      : ${modelPath}`);
  console.log(`Dung lượng     : ${(stat.size / (1024 * 1024)).toFixed(2)} MB (${stat.size.toLocaleString('en-US')} bytes)`);
  console.log(`glTF Version   : ${headerInfo.version}`);
  console.log(`Asset          : ${JSON.stringify(headerInfo.asset)}`);
  console.log(`ExtensionsUsed : ${JSON.stringify(headerInfo.extensionsUsed)}`);
  console.log(`ExtensionsReq  : ${JSON.stringify(headerInfo.extensionsRequired)}`);

  const io = new NodeIO();
  const doc = await io.read(modelPath);
  const root = doc.getRoot();

  const scenes = root.listScenes();
  const allNodes = root.listNodes();
  const meshes = root.listMeshes();
  const materials = root.listMaterials();
  const textures = root.listTextures();
  const animations = root.listAnimations();

  console.log('\n--- TỔNG QUAN TÀI NGUYÊN ---');
  console.log(`Scenes     : ${scenes.length}`);
  console.log(`Nodes      : ${allNodes.length}`);
  console.log(`Meshes     : ${meshes.length}`);
  console.log(`Materials  : ${materials.length}`);
  console.log(`Textures   : ${textures.length}`);
  console.log(`Animations : ${animations.length}`);

  if (textures.length > 0) {
    console.log('\n--- DANH SÁCH TEXTURE ---');
    let totalTexBytes = 0;
    textures.forEach((tex, idx) => {
      const img = tex.getImage();
      const bytes = img ? img.byteLength : 0;
      totalTexBytes += bytes;
      const size = tex.getSize();
      console.log(
        `  [${idx}] name="${tex.getName() || '(unnamed)'}" | mime=${tex.getMimeType()} | ` +
        `size=${size ? `${size[0]}x${size[1]}` : 'unknown'} | ${(bytes / (1024 * 1024)).toFixed(2)} MB`
      );
    });
    console.log(`  Tổng dung lượng texture (chưa giải nén GPU): ${(totalTexBytes / (1024 * 1024)).toFixed(2)} MB`);
  }

  console.log('\n--- DANH SÁCH MATERIAL ---');
  materials.forEach((mat, idx) => {
    const color = mat.getBaseColorFactor().map((v) => fmt(v, 3));
    const hasBaseTex = Boolean(mat.getBaseColorTexture());
    const hasNormTex = Boolean(mat.getNormalTexture());
    const hasMrTex = Boolean(mat.getMetallicRoughnessTexture());
    console.log(
      `  [${idx}] "${mat.getName() || '(unnamed)'}" | baseColor=[${color.join(', ')}] | ` +
      `metal=${fmt(mat.getMetallicFactor(), 2)} | rough=${fmt(mat.getRoughnessFactor(), 2)} | ` +
      `textures(base=${hasBaseTex}, normal=${hasNormTex}, mr=${hasMrTex})`
    );
  });

  // Duyệt cây node và tính toán world bounding box
  console.log('\n--- CÂY NODE (PARENT / CHILD) ---');
  const meshNodesSummary = [];
  const totalBox = createEmptyBox();
  let totalVertices = 0;
  let totalTriangles = 0;

  function inspectNode(node, depth = 0, parentName = '(scene-root)') {
    const indent = '  '.repeat(depth);
    const name = node.getName() || '(unnamed)';
    const mesh = node.getMesh();
    const children = node.listChildren();
    let kind = 'Empty';
    if (mesh) kind = 'Mesh';
    else if (node.getCamera()) kind = 'Camera';
    else if (children.length > 0) kind = 'Group';

    const t = node.getTranslation();
    const r = quatToEulerDeg(node.getRotation());
    const s = node.getScale();
    const worldM = node.getWorldMatrix();
    const worldOrigin = [worldM[12], worldM[13], worldM[14]];

    const meshStats = computeNodeMeshStats(node);
    const subtreeBox = createEmptyBox();
    mergeBox(subtreeBox, meshStats.box);
    mergeBox(totalBox, meshStats.box);
    totalVertices += meshStats.vertices;
    totalTriangles += meshStats.triangles;

    const metrics = getBoxMetrics(meshStats.box);
    const meshLabel = mesh
      ? ` | mesh="${mesh.getName() || '(unnamed)'}" | prims=${meshStats.primitives} | verts=${meshStats.vertices} | tris=${meshStats.triangles} | mats=[${meshStats.materials.join(', ')}]`
      : '';

    console.log(
      `${indent}- ${name} [${kind}] (parent: ${parentName})${meshLabel}`
    );
    console.log(
      `${indent}    local T=${fmtVec3(t)} R(deg)=${fmtVec3(r, 1)} S=${fmtVec3(s)} | worldOrigin=${fmtVec3(worldOrigin)}`
    );
    if (metrics) {
      console.log(
        `${indent}    worldBBox size=${fmtVec3(metrics.size)} center=${fmtVec3(metrics.center)} ` +
        `min=${fmtVec3(metrics.min)} max=${fmtVec3(metrics.max)}`
      );
      meshNodesSummary.push({
        name,
        parentName,
        meshName: mesh.getName() || '(unnamed)',
        vertices: meshStats.vertices,
        triangles: meshStats.triangles,
        materials: meshStats.materials,
        localScale: s,
        worldOrigin,
        metrics,
      });
    }

    for (const child of children) {
      const childBox = inspectNode(child, depth + 1, name);
      mergeBox(subtreeBox, childBox);
    }

    // Nếu là Group không trực tiếp có mesh nhưng có con có mesh, in thêm bbox gộp của cả nhánh
    if (!mesh && !subtreeBox.empty) {
      const subMetrics = getBoxMetrics(subtreeBox);
      console.log(
        `${indent}    [Group WorldBBox] size=${fmtVec3(subMetrics.size)} center=${fmtVec3(subMetrics.center)} ` +
        `min=${fmtVec3(subMetrics.min)} max=${fmtVec3(subMetrics.max)}`
      );
    }

    return subtreeBox;
  }

  scenes.forEach((scene, sIdx) => {
    console.log(`Scene[${sIdx}] "${scene.getName() || '(default)'}"`);
    for (const child of scene.listChildren()) {
      inspectNode(child, 1, `Scene[${sIdx}]`);
    }
  });

  // Phân tích tổng thể & hướng trục
  console.log('\n--- PHÂN TÍCH TỔNG THỂ, ĐƠN VỊ & HƯỚNG TRỤC ---');
  console.log(`Tổng số node có mesh : ${meshNodesSummary.length}`);
  console.log(`Tổng số đỉnh         : ${totalVertices.toLocaleString('en-US')}`);
  console.log(`Tổng số tam giác     : ${totalTriangles.toLocaleString('en-US')}`);

  const totalMetrics = getBoxMetrics(totalBox);
  if (totalMetrics) {
    const [sx, sy, sz] = totalMetrics.size;
    console.log(`World BBox toàn cảnh : size=${fmtVec3(totalMetrics.size)}`);
    console.log(`  min                : ${fmtVec3(totalMetrics.min)}`);
    console.log(`  max                : ${fmtVec3(totalMetrics.max)}`);
    console.log(`  center             : ${fmtVec3(totalMetrics.center)}`);

    // Suy đoán hướng trục dựa trên tỷ lệ chiều cao so với hai cạnh ngang của bàn cờ
    let upAxisGuess = 'Không rõ';
    if (sy < sx * 0.7 && sy < sz * 0.7 && Math.abs(sx - sz) / Math.max(sx, sz) < 0.35) {
      upAxisGuess = 'Y-up (chuẩn glTF: mặt bàn nằm trên mặt phẳng XZ, chiều cao theo trục Y)';
    } else if (sz < sx * 0.7 && sz < sy * 0.7 && Math.abs(sx - sy) / Math.max(sx, sy) < 0.35) {
      upAxisGuess = 'Z-up (mặt bàn nằm trên mặt phẳng XY, chiều cao theo trục Z — cần xoay -90 độ quanh X)';
    } else {
      upAxisGuess = `Cần kiểm tra thủ công (size X=${fmt(sx)}, Y=${fmt(sy)}, Z=${fmt(sz)})`;
    }

    const maxDim = Math.max(sx, sy, sz);
    let unitGuess = 'mét (m) - chuẩn glTF';
    if (maxDim > 20 && maxDim <= 200) unitGuess = 'có thể là centimet (cm) hoặc đơn vị tùy ý lớn';
    else if (maxDim > 200) unitGuess = 'có thể là milimet (mm)';
    else if (maxDim < 0.1) unitGuess = 'rất nhỏ (có thể scale 0.01)';

    console.log(`Nhận định hướng trục : ${upAxisGuess}`);
    console.log(`Nhận định đơn vị     : glTF mặc định mét; maxDim=${fmt(maxDim)} -> ${unitGuess}`);
  }

  // In bảng gọn các mesh node sắp theo tên để dễ đối chiếu
  if (meshNodesSummary.length > 0) {
    console.log('\n--- BẢNG TÓM TẮT CÁC MESH NODE (SẮP THEO TỌA ĐỘ Z, X) ---');
    const sorted = [...meshNodesSummary].sort((a, b) => {
      const dz = a.metrics.center[2] - b.metrics.center[2];
      if (Math.abs(dz) > 0.001) return dz;
      return a.metrics.center[0] - b.metrics.center[0];
    });
    sorted.forEach((item, idx) => {
      const c = item.metrics.center;
      const sz = item.metrics.size;
      const minY = item.metrics.min[1];
      console.log(
        `  ${String(idx + 1).padStart(2, ' ')}. ${item.name.padEnd(28, ' ')} | ` +
        `center=(${fmt(c[0], 3)}, ${fmt(c[1], 3)}, ${fmt(c[2], 3)}) | ` +
        `size=(${fmt(sz[0], 3)}, ${fmt(sz[1], 3)}, ${fmt(sz[2], 3)}) | ` +
        `minY=${fmt(minY, 3)} | tris=${item.triangles} | mats=[${item.materials.join(',')}]`
      );
    });
  }
}

main().catch((err) => {
  console.error('\nLỖI KHI ĐỌC GLB:', err);
  process.exit(1);
});

