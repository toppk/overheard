import { defineConfig } from 'astro/config';

export default defineConfig({
  // Built output is served by the Node signaling server (server/index.ts).
  outDir: './dist',
});
