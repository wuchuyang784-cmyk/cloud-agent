import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');

  return {
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: env.API_TARGET || 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '/healthz': {
        target: env.API_TARGET || 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  };
});
