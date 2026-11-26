import { defineConfig } from 'vite'

// The browser half of video sessions: one self-contained script, served by the API at
// /video/chime-client.js. Built after the web app (`npm run build`), into the same dist/.
export default defineConfig({
  // Chime's browser code was written for bundlers that fill in Node's `global`; Vite's library mode does not, and the
  // call then dies on `ReferenceError: global is not defined` the moment it starts. Library mode also leaves
  // process.env.NODE_ENV undefined. Both are fixed here; a test (server/lib/video-bundle-config.test.ts) guards them.
  define: {
    global: 'globalThis',
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: 'client-video/entry.ts', formats: ['iife'], name: 'PsyVideoBundle', fileName: () => 'video/chime-client.js' },
    minify: true,
    sourcemap: false,
  },
})
