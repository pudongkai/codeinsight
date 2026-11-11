import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 单文件 HTML 报告模板：JS、CSS 全部内联，不引用任何外部资源。
 * 输出到 dist/report.html（与 serve 用的产物放在一起，cli 打包时一并复制）。
 */
export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: { input: 'report.html' },
  },
});
