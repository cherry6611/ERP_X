import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 说明：本配置已与飞书秒搭平台解耦，为纯原生 Vite 配置。
// root 指向 client/ —— 入口 HTML 位于 client/index.html；
// 产物输出到 dist/client，由 Nest 的 ViewController 以 hbs 视图方式托管。
export default defineConfig({
  root: path.resolve(__dirname, 'client'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'client/src'),
      '@client': path.resolve(__dirname, 'client'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  define: {
    'process.env.CLIENT_BASE_PATH': JSON.stringify(process.env.CLIENT_BASE_PATH || '/'),
  },
  server: {
    // 显式绑定 127.0.0.1：Windows 下默认 localhost 只监听 ::1，
    // 会导致 http://127.0.0.1:5173 无法访问、且与后端代理目标不一致。
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Vite 8 / rolldown 要求 manualChunks 为函数（对象形式会 TypeError）
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (
            id.includes('react-dom') ||
            id.includes('react-router') ||
            /[/\\]react[/\\]/.test(id)
          ) {
            return 'react';
          }
          if (id.includes('antd') || id.includes('@ant-design')) {
            return 'antd';
          }
          /**
           * F1：**不要**把 echarts 归入手动 chunk。
           *
           * 曾经这里是 `if (id.includes('echarts')) return 'charts';`。
           * 但手动 chunk 会让 rolldown 把 echarts 的**辅助函数导出**
           * （`__assign` / `__rest` / `__awaiter` 等 TS 降级 helper）也放进
           * `charts` chunk，而 `EChart.tsx`（被页面 chunk 静态引用）恰好需要
           * 这些 helper → `es2015` 公共 chunk 静态 `import{...}from"./charts-*.js"`
           * → 入口又静态引用 `es2015` → **首屏预加载整个 1,136 KB 的 charts**。
           *
           * 实测证据（构建产物可复核）：
           *   · `es2015-*.js` 的 import 列表含 `from"./charts-*.js"`
           *   · `index.html` 的 `modulepreload` 列表含 `charts-*.js`
           * 去掉这条手动 chunk 后，echarts 只被**动态导入**的
           * `echarts-for-react` 引用，`index.html` 的预加载列表里不再有 charts。
           */
        },
      },
    },
  },
});

