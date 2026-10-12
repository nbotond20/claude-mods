import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * The UI is built on Loam's component source (Scheduler, form controls, tokens).
 * Loam is only needed to BUILD the UI: the output in web/dist is what ships, so
 * people installing timesheet never need Loam. Point LOAM_DIR at a checkout;
 * the default is a sibling directory.
 */
const LOAM = resolve(process.env.LOAM_DIR ?? resolve(__dirname, '..', '..', 'loam'));
if (!existsSync(resolve(LOAM, 'packages/ui-web/src/index.ts'))) {
  throw new Error(`Loam not found at ${LOAM}. Set LOAM_DIR to a loam checkout (with pnpm install run) to build the UI.`);
}

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@loam\/ui-web\/styles\.css$/, replacement: `${LOAM}/packages/ui-web/src/styles.css` },
      { find: /^@loam\/ui-web$/, replacement: `${LOAM}/packages/ui-web/src/index.ts` },
      { find: /^@loam\/theme-web$/, replacement: `${LOAM}/packages/theme-web/src/index.ts` },
    ],
    // Loam's source imports react from its own node_modules; force one copy.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  server: {
    fs: { allow: [__dirname, LOAM] },
    proxy: { '/api': process.env.TIMESHEET_API ?? 'http://127.0.0.1:4280' },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
