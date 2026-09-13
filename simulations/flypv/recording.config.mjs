import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Freeze just this entry and its shared dependencies for HMR-free recording.
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  base: '/',
  build: {
    outDir: fileURLToPath(new URL('./verification/recording-build/', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) },
  },
  preview: { host: '127.0.0.1', port: 5187, strictPort: true },
});
