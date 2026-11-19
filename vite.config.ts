import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:2567',
      '/ops': 'http://127.0.0.1:2567',
      '/matchmake': 'http://127.0.0.1:2567',
      '^/[^/]+/[^/]+\\?': { target: 'ws://127.0.0.1:2567', ws: true },
    },
  },
});
