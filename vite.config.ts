import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// Multi-page static site: a landing page plus the phone controller and the
// computer game. Both are served over HTTPS on Vercel so the phone's
// DeviceOrientation API and WebRTC are available.
//
// simple-peer is a Node library, so we polyfill the Node globals/modules its
// dependency chain (readable-stream, buffer, ...) expects in the browser.
export default defineConfig({
  base: './',
  plugins: [
    nodePolyfills({
      include: ['buffer', 'events', 'process', 'stream', 'string_decoder', 'util'],
      globals: { global: true, Buffer: true, process: true },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        controller: 'controller.html',
        game: 'game.html',
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
