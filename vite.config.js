import { defineConfig } from 'vite';

export default defineConfig({
  // Thư mục chứa file tĩnh (public/models/chess_set.glb -> phục vụ ở /models/chess_set.glb)
  publicDir: 'public',
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Không nhân bản file public/models/chess_set.glb (145MB) vào dist/ vì Express đã phục vụ trực tiếp từ public/
    copyPublicDir: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Tách riêng các thư viện lớn để trình duyệt cache hiệu quả và tăng tốc tải trang
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'vendor-three';
          if (id.includes('node_modules/socket.io-client') || id.includes('node_modules/engine.io-client')) {
            return 'vendor-socket';
          }
          if (id.includes('node_modules/chess.js')) return 'vendor-chess';
          return undefined;
        },
      },
    },
  },
});
