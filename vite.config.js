import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 8001,
    strictPort: true,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  assetsInclude: ['**/*.glb', '**/*.gltf'],
});
