import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // `npm run web:dev` for hot reload; the API keeps running on 3000.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
