import { defineConfig } from 'vite'

// The browser half of video sessions: one self-contained script, served by the API at
// /video/chime-client.js. Built after the web app (`npm run build`), into the same dist/.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: 'client-video/entry.ts', formats: ['iife'], name: 'PsyVideoBundle', fileName: () => 'video/chime-client.js' },
    minify: true,
    sourcemap: false,
  },
})
