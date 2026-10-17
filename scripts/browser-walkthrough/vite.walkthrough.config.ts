/**
 * 浏览器全量走查专用 Vite 配置（不参与生产构建、不被 CI 门禁扫描）。
 *
 * 为什么需要单独一份：
 *   仓库默认 `vite.config.ts` 把 `/api` 代理到 **:3000**（用户正在开发的 dev server）。
 *   本走查要求"浏览器 + 后端跑的都是当前工作区代码"，且**不得干扰**用户已启动的服务，
 *   因此这里把 Vite 起在 :5273、代理指向本次验证用后端 :3100。
 *
 * 用法：npx vite --config scripts/browser-walkthrough/vite.walkthrough.config.ts
 */
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const ROOT = path.resolve(__dirname, '..', '..');

export default defineConfig({
  root: path.resolve(ROOT, 'client'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(ROOT, 'client/src'),
      '@client': path.resolve(ROOT, 'client'),
      '@shared': path.resolve(ROOT, 'shared'),
    },
  },
  define: {
    'process.env.CLIENT_BASE_PATH': JSON.stringify(process.env.CLIENT_BASE_PATH || '/'),
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    // Windows 下原生 fs.watch 在编辑器/工具做"原子保存"（写临时文件再重命名）时会
    // 撞 EBUSY 并**直接打崩 Vite 进程**（实测：保存 badge.tsx 后 vite 退出 exit 1）。
    // 走轮询式监听避免该问题；只影响本走查实例，不影响仓库默认配置。
    watch: { usePolling: true, interval: 400 },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3100',
        changeOrigin: true,
      },
    },
  },
});
