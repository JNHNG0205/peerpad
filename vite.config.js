import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Builds everything into one self-contained dist/index.html you can host anywhere.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
})
