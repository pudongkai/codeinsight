import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** serve 托管的 Web UI：相对路径资源，产物在 dist/ */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4096 },
});
