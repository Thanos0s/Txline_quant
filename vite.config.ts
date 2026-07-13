import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        // Disable Vite's response buffering so SSE bytes reach the browser immediately
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            const ct = proxyRes.headers['content-type'] ?? '';
            if (ct.includes('text/event-stream')) {
              // Force chunked transfer so the browser gets headers right away
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Accel-Buffering', 'no');
            }
          });
        },
      },
    },
  },
});
