import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  base: process.env.VITE_BASE ?? '/', // GitHub Pages 子路径部署时设为 /仓库名/
  envDir: fileURLToPath(new URL('.', import.meta.url)), // .env 放项目根目录
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
