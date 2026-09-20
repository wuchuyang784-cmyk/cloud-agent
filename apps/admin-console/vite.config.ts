import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.ADMIN_CONSOLE_PORT || 5174), strictPort: true },
});
