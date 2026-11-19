/**
 * Quản lý cảnh 3D Three.js:
 * - Scene, nền gradient, môi trường ánh sáng phản chiếu (RoomEnvironment)
 * - Camera phối cảnh & OrbitControls có giới hạn góc/zoom
 * - Ánh sáng (Hemisphere + Directional đổ bóng mềm + Fill light)
 * - Nhãn tọa độ a-h / 1-8 quanh viền bàn cờ
 * - Vòng lặp render, resize và giải phóng bộ nhớ (dispose)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** Tạo texture nền gradient dọc nhẹ nhàng cho scene */
function createGradientBackgroundTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0.0, '#16202e');
  grad.addColorStop(0.55, '#1d2838');
  grad.addColorStop(1.0, '#0d121a');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Tạo một tấm nhãn chữ (a-h hoặc 1-8) phẳng đặt trên viền bàn cờ */
function createCoordLabelMesh(text) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(240, 214, 155, 0.92)';
  ctx.font = '700 68px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const geometry = new THREE.PlaneGeometry(0.46, 0.46);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/** Tạo nhóm nhãn tọa độ a-h và 1-8 bao quanh lưới 8x8 */
function createCoordinateLabelsGroup() {
  const group = new THREE.Group();
  group.name = 'BoardCoordinates';

  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const edgeOffset = 4.46; // Nằm ngay trên viền bàn cờ (lưới 8x8 chạy từ -4 đến +4)
  const labelY = 0.012;

  for (let i = 0; i < 8; i++) {
    const pos = i - 3.5;

    // Nhãn cột a-h phía Trắng (+Z) và phía Đen (-Z, xoay 180 độ để bên Đen đọc thuận chiều)
    const fileSouth = createCoordLabelMesh(files[i]);
    fileSouth.position.set(pos, labelY, edgeOffset);
    group.add(fileSouth);

    const fileNorth = createCoordLabelMesh(files[i]);
    fileNorth.position.set(pos, labelY, -edgeOffset);
    fileNorth.rotation.z = Math.PI;
    group.add(fileNorth);

    // Nhãn hàng 1-8 phía trái (-X) và phía phải (+X)
    const rankLabel = String(i + 1);
    const rankZ = 3.5 - i;

    const rankWest = createCoordLabelMesh(rankLabel);
    rankWest.position.set(-edgeOffset, labelY, rankZ);
    group.add(rankWest);

    const rankEast = createCoordLabelMesh(rankLabel);
    rankEast.position.set(edgeOffset, labelY, rankZ);
    rankEast.rotation.z = Math.PI;
    group.add(rankEast);
  }

  return group;
}

/**
 * Khởi tạo toàn bộ cảnh 3D cho bàn cờ.
 * @param {HTMLCanvasElement} canvas
 */
export function createChessScene(canvas) {
  // 1. Khởi tạo Renderer (giới hạn pixelRatio <= 2 để tối ưu hiệu năng)
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // 2. Scene + nền gradient + môi trường phản chiếu (rất cần vì bàn cờ có metalness = 1)
  const scene = new THREE.Scene();
  const bgTexture = createGradientBackgroundTexture();
  scene.background = bgTexture;

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const envRoom = new RoomEnvironment();
  const envRT = pmremGenerator.fromScene(envRoom, 0.04);
  scene.environment = envRT.texture;
  envRoom.dispose();
  pmremGenerator.dispose();

  // 3. Camera phối cảnh
  const parent = canvas.parentElement || document.body;
  const initWidth = parent.clientWidth || window.innerWidth;
  const initHeight = parent.clientHeight || window.innerHeight;
  const camera = new THREE.PerspectiveCamera(42, initWidth / initHeight, 0.1, 100);
  camera.position.set(0, 8.6, 9.4);

  // 4. OrbitControls: mượt mà, giới hạn zoom và không cho chui xuống dưới mặt bàn
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  controls.minDistance = 5.5;
  controls.maxDistance = 21;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI / 2 - 0.09;
  controls.target.set(0, 0.15, 0);
  controls.update();

  // 5. Hệ thống ánh sáng
  const hemiLight = new THREE.HemisphereLight(0xf4f7ff, 0x262c38, 0.75);
  scene.add(hemiLight);

  // Đèn chính có đổ bóng mềm
  const mainLight = new THREE.DirectionalLight(0xfff5e4, 2.2);
  mainLight.position.set(7.5, 13.5, 8.5);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.set(2048, 2048);
  mainLight.shadow.camera.near = 2;
  mainLight.shadow.camera.far = 35;
  const shadowRange = 6.8;
  mainLight.shadow.camera.left = -shadowRange;
  mainLight.shadow.camera.right = shadowRange;
  mainLight.shadow.camera.top = shadowRange;
  mainLight.shadow.camera.bottom = -shadowRange;
  mainLight.shadow.bias = -0.0005;
  mainLight.shadow.normalBias = 0.02;
  scene.add(mainLight);

  // Đèn phụ (fill / rim) từ phía đối diện để các quân đen vẫn nổi rõ khối
  const fillLight = new THREE.DirectionalLight(0xbcd3ff, 0.9);
  fillLight.position.set(-8, 7.5, -9);
  scene.add(fillLight);

  // Mặt phẳng hứng bóng mềm dưới chân bàn cờ
  const shadowPlaneGeo = new THREE.PlaneGeometry(32, 32);
  const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.32 });
  const shadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = -0.20;
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);

  // Nhãn tọa độ quanh viền bàn cờ
  const coordsGroup = createCoordinateLabelsGroup();
  scene.add(coordsGroup);

  // Trạng thái chuyển góc nhìn mượt (camera lerp)
  let cameraTransition = null;

  /**
   * Đặt góc nhìn mặc định theo màu quân ('w' nhìn từ +Z, 'b' nhìn từ -Z).
   * @param {'w' | 'b'} side
   * @param {boolean} instant
   */
  function setCameraSide(side, instant = false) {
    const zSign = side === 'b' ? -1 : 1;
    const isPortrait = camera.aspect < 0.85;
    // Trên điện thoại màn hình dọc, lùi camera ra một chút để thấy trọn bàn cờ
    const distScale = isPortrait ? 1.32 : 1.0;
    const targetPos = new THREE.Vector3(0, 8.6 * distScale, 9.4 * zSign * distScale);

    if (instant) {
      cameraTransition = null;
      camera.position.copy(targetPos);
      controls.target.set(0, 0.15, 0);
      controls.update();
      return;
    }

    cameraTransition = {
      startPos: camera.position.clone(),
      endPos: targetPos,
      elapsed: 0,
      duration: 0.65,
    };
  }

  // Nếu người dùng chủ động kéo xoay camera thì hủy hiệu ứng tự chuyển góc
  controls.addEventListener('start', () => {
    cameraTransition = null;
  });

  function setCoordsVisible(visible) {
    coordsGroup.visible = Boolean(visible);
  }

  function resize() {
    const container = canvas.parentElement || document.body;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  resize();
  window.addEventListener('resize', resize);

  let rafId = 0;
  let lastTime = performance.now();

  function startLoop(onFrame) {
    function tick(now) {
      rafId = requestAnimationFrame(tick);
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      if (cameraTransition) {
        cameraTransition.elapsed += dt;
        const t = Math.min(cameraTransition.elapsed / cameraTransition.duration, 1);
        // Easing cubic ease-out
        const eased = 1 - Math.pow(1 - t, 3);
        camera.position.lerpVectors(cameraTransition.startPos, cameraTransition.endPos, eased);
        if (t >= 1) cameraTransition = null;
      }

      controls.update();
      if (onFrame) onFrame(dt);
      renderer.render(scene, camera);
    }

    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function dispose() {
    if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener('resize', resize);
    controls.dispose();
    bgTexture.dispose();
    envRT.dispose();
    shadowPlaneGeo.dispose();
    shadowPlaneMat.dispose();
    coordsGroup.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry?.dispose();
        obj.material?.map?.dispose();
        obj.material?.dispose();
      }
    });
    renderer.dispose();
  }

  return {
    scene,
    camera,
    renderer,
    controls,
    setCameraSide,
    setCoordsVisible,
    resize,
    startLoop,
    dispose,
  };
}

