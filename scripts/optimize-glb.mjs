/**
 * Script tối ưu file 3D `public/models/chess_set.glb` (145 MB) -> `public/models/chess_set_opt.glb` (~3-6 MB)
 * để deploy web public tải nhanh trên cả máy tính và điện thoại (vẫn giữ nguyên file gốc ở local).
 *
 * Chiến lược tối ưu (không làm thay đổi hệ tọa độ hay ánh xạ node của client/pieces.js):
 * 1. Chỉ giữ lại đúng 13 node mẫu cần thiết (Chess_board + 12 mẫu quân 6 loại x 2 màu), loại bỏ 20 bản sao thừa.
 * 2. Chỉ giảm lưới (simplify) các mesh siêu nặng > 20,000 tam giác (quân Tượng Piece_04 ~347k tris -> ~13k tris),
 *    giữ nguyên 100% hình học gốc của bàn cờ và các quân còn lại.
 * 3. Nén 11 texture 4096x4096 PNG xuống 1024x1024 WebP (chất lượng 85%).
 * 4. Gộp dữ liệu trùng (dedup) và dọn tài nguyên không dùng (prune).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.resolve(__dirname, '../public/models/chess_set.glb');
const outputPath = path.resolve(__dirname, '../public/models/chess_set_opt.glb');

/** 13 node mẫu được client/pieces.js sử dụng trực tiếp */
const KEEP_ROOT_CHILDREN = new Set([
  'Chess_board',
  'Piece_01',
  'Piece_02',
  'Piece_03',
  'Piece_04',
  'Piece_05',
  'Piece_06',
  'Piece_01.008',
  'Piece_02.002',
  'Piece_03.002',
  'Piece_04.002',
  'Piece_05.001',
  'Piece_06.001',
]);

/** Dọn sạch các mesh, primitive, accessor không còn node nào tham chiếu (thuần @gltf-transform/core) */
function pruneUnusedResources(doc) {
  const root = doc.getRoot();
  let removedMeshes = 0;
  let removedAccessors = 0;

  for (const mesh of [...root.listMeshes()]) {
    const usedByNode = mesh.listParents().some((p) => p.propertyType === 'Node');
    if (!usedByNode) {
      for (const prim of [...mesh.listPrimitives()]) {
        prim.dispose();
      }
      mesh.dispose();
      removedMeshes += 1;
    }
  }

  for (const accessor of [...root.listAccessors()]) {
    const usedByMesh = accessor.listParents().some((p) => p.propertyType === 'Primitive');
    if (!usedByMesh) {
      accessor.dispose();
      removedAccessors += 1;
    }
  }

  return { removedMeshes, removedAccessors };
}

/** Giảm số tam giác cho các primitive siêu nặng (> 20k tam giác) bằng MeshoptSimplifier */
function simplifyHeavyPrimitives(doc, MeshoptSimplifier, targetRatio = 0.045, minTrisThreshold = 20000) {
  let simplifiedCount = 0;

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indicesAcc = prim.getIndices();
      const posAcc = prim.getAttribute('POSITION');
      if (!indicesAcc || !posAcc) continue;

      const indexCount = indicesAcc.getCount();
      const triCount = Math.floor(indexCount / 3);
      if (triCount < minTrisThreshold) continue;

      const srcIndices = new Uint32Array(indicesAcc.getArray());
      const srcPositions = new Float32Array(posAcc.getArray());
      const targetIndexCount = Math.max(300, Math.floor(triCount * targetRatio) * 3);

      const [dstIndices, error] = MeshoptSimplifier.simplify(
        srcIndices,
        srcPositions,
        3,
        targetIndexCount,
        0.02
      );

      // Nén gọn lại vertex buffer (chỉ giữ các đỉnh thực sự còn được dùng sau khi simplify!)
      const usedMap = new Int32Array(posAcc.getCount()).fill(-1);
      const oldIndicesList = [];
      let nextNewIdx = 0;
      const remappedIndices = new Uint32Array(dstIndices.length);
      for (let i = 0; i < dstIndices.length; i++) {
        const oldIdx = dstIndices[i];
        let mapped = usedMap[oldIdx];
        if (mapped === -1) {
          mapped = nextNewIdx++;
          usedMap[oldIdx] = mapped;
          oldIndicesList.push(oldIdx);
        }
        remappedIndices[i] = mapped;
      }

      // Cắt gọn toàn bộ attribute (POSITION, NORMAL, TEXCOORD_0, ...) theo danh sách đỉnh còn dùng
      for (const semantic of prim.listSemantics()) {
        const acc = prim.getAttribute(semantic);
        const elemSize = acc.getElementSize();
        const SrcArrayCtor = acc.getArray().constructor;
        const compact = new SrcArrayCtor(oldIndicesList.length * elemSize);
        const tmp = new Array(elemSize);
        for (let ni = 0; ni < oldIndicesList.length; ni++) {
          acc.getElement(oldIndicesList[ni], tmp);
          for (let k = 0; k < elemSize; k++) {
            compact[ni * elemSize + k] = tmp[k];
          }
        }
        acc.setArray(compact);
      }

      const compactIndices = nextNewIdx <= 65535 ? new Uint16Array(remappedIndices) : remappedIndices;
      indicesAcc.setArray(compactIndices);

      console.log(
        `  - Simplify "${mesh.getName()}": ${triCount.toLocaleString('en-US')} -> ` +
          `${Math.floor(dstIndices.length / 3).toLocaleString('en-US')} tris, ` +
          `${posAcc.getCount().toLocaleString('en-US')} verts (err=${error.toFixed(4)})`
      );
      simplifiedCount += 1;
    }
  }

  return simplifiedCount;
}

async function main() {
  if (!fs.existsSync(inputPath)) {
    console.error(`Không tìm thấy file gốc tại: ${inputPath}`);
    process.exit(1);
  }

  const origBytes = fs.statSync(inputPath).size;
  console.log(`Đang đọc file gốc: ${inputPath} (${(origBytes / 1024 / 1024).toFixed(2)} MB)...`);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(inputPath);

  // 1. Nén toàn bộ texture 4096x4096 PNG -> 1024x1024 JPEG/PNG trước khi khởi tạo WASM MeshoptSimplifier
  console.log('1. Đang nén texture 4096x4096 -> 1024x1024...');
  const textures = doc.getRoot().listTextures();
  for (let i = 0; i < textures.length; i++) {
    const tex = textures[i];
    const srcImg = tex.getImage();
    if (!srcImg) continue;

    const srcBuf = Buffer.from(srcImg);
    const decoded = await sharp(srcBuf).raw().toBuffer({ resolveWithObject: true });

    // Kiểm tra xem ảnh có thực sự dùng kênh trong suốt không (alpha < 255)
    let needsAlpha = false;
    if (decoded.info.channels === 4) {
      const data = decoded.data;
      for (let p = 3; p < data.length; p += 4) {
        if (data[p] < 255) {
          needsAlpha = true;
          break;
        }
      }
    }

    const resized = sharp(decoded.data, {
      raw: {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: decoded.info.channels,
      },
    }).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true });

    let outBuf;
    let outMime;
    if (needsAlpha) {
      outBuf = await resized.png({ compressionLevel: 9, palette: true, quality: 85 }).toBuffer();
      outMime = 'image/png';
    } else {
      const rgbPipeline = decoded.info.channels === 4 ? resized.removeAlpha() : resized;
      outBuf = await rgbPipeline.jpeg({ quality: 85 }).toBuffer();
      outMime = 'image/jpeg';
    }

    tex.setImage(new Uint8Array(outBuf));
    tex.setMimeType(outMime);
    console.log(
      `  - Texture[${i}]: ${decoded.info.width}x${decoded.info.height} (${(srcBuf.length / 1024 / 1024).toFixed(2)} MB) -> ` +
        `1024x1024 ${outMime} (${(outBuf.length / 1024).toFixed(1)} KB)`
    );
  }

  // 2. Giữ đúng 13 group mẫu dưới RootNode, xóa 20 bản sao thừa
  const rootNode = doc.getRoot().listNodes().find((n) => n.getName() === 'RootNode');
  if (!rootNode) {
    throw new Error('Không tìm thấy node "RootNode" trong file GLB.');
  }

  let removedGroups = 0;
  for (const child of [...rootNode.listChildren()]) {
    const name = child.getName();
    if (!KEEP_ROOT_CHILDREN.has(name)) {
      const disposeSubtree = (node) => {
        for (const grand of [...node.listChildren()]) {
          disposeSubtree(grand);
        }
        node.dispose();
      };
      disposeSubtree(child);
      removedGroups += 1;
    }
  }
  console.log(`2. Đã loại bỏ ${removedGroups} nhóm quân cờ bản sao thừa (giữ lại đúng 13 node mẫu).`);

  // 3. Dọn sạch mesh và accessor thừa sau khi xóa 20 quân bản sao
  const pruned = pruneUnusedResources(doc);
  console.log(`   Đã dọn ${pruned.removedMeshes} mesh và ${pruned.removedAccessors} accessor thừa.`);

  // 4. Simplify riêng các mesh siêu nặng của 2 quân Tượng (Piece_04, Piece_04.002)
  const { MeshoptSimplifier } = await import('meshoptimizer');
  await MeshoptSimplifier.ready;
  console.log('3. Đang giảm lưới các mesh siêu nặng (> 20,000 tam giác)...');
  const simplifiedCount = simplifyHeavyPrimitives(doc, MeshoptSimplifier, 0.045, 20000);
  console.log(`   Đã giảm lưới ${simplifiedCount} primitive.`);

  // 5. Dọn lần cuối và ghi ra file tối ưu (giữ nguyên file gốc)
  pruneUnusedResources(doc);
  await io.write(outputPath, doc);

  const outBytes = fs.statSync(outputPath).size;
  const ratio = ((1 - outBytes / origBytes) * 100).toFixed(1);
  console.log('\n============================================================');
  console.log('HOÀN TẤT TỐI ƯU MODEL GLB!');
  console.log(`  File gốc   : ${(origBytes / 1024 / 1024).toFixed(2)} MB (giữ nguyên)`);
  console.log(`  File deploy: ${(outBytes / 1024 / 1024).toFixed(2)} MB (giảm ${ratio}%)`);
  console.log(`  Đường dẫn  : ${outputPath}`);
  console.log('============================================================');
}

main().catch((err) => {
  console.error('LỖI KHI TỐI ƯU GLB:', err);
  process.exit(1);
});
