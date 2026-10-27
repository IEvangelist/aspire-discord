import { defineConfig } from 'vite';
import { excerptsPlugin } from './plugins/excerpts';

export default defineConfig({
  base: '/aspire-discord/',
  plugins: [excerptsPlugin()],
  build: {
    target: 'es2022',
    sourcemap: false,
    outDir: process.env.DECK_OUT_DIR ?? 'dist',
  },
});
