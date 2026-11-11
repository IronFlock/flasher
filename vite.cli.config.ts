import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// flockflasher, the command-line tool (src/cli): one CommonJS file for Node 18
// or later, with nothing but Node's own modules, so it runs where it is copied
// (README, "Command line").
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  define: {
    __FLOCKFLASHER_VERSION__: JSON.stringify(version)
  },
  ssr: {
    // bundle everything the sources import; Node's modules stay external
    noExternal: true
  },
  build: {
    ssr: 'src/cli/main.ts',
    outDir: 'out/cli',
    emptyOutDir: true,
    target: 'node18',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        format: 'cjs',
        entryFileNames: 'flockflasher.cjs',
        banner: '#!/usr/bin/env node'
      }
    }
  }
})
