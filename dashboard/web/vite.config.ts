import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import * as path from 'path';

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  /*
   * `@/` for shadcn's generated components, which are written with that alias
   * and would otherwise need editing on every `shadcn add`. It must be
   * declared in BOTH places -- here for the bundler and in tsconfig.json's
   * `paths` for the typechecker -- and the two disagreeing is a build that
   * passes and a typecheck that does not.
   */
  resolve: {
    alias: { '@': path.join(__dirname, 'src') },
  },
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    /*
     * `npm run dev:server` in one terminal, `npm run dev` in another.
     *
     * The target follows the same variables the API binds (`PORT` in
     * `server/index.ts`, default 3000) instead of being hardcoded here. A
     * pinned 3000 against a server started with `PORT=4173` is a proxy with
     * nothing behind it, and Vite answers that with a 502 carrying an empty
     * body -- which the page then reports as a ledger it could not read, with
     * the database never contacted.
     */
    proxy: { '/api': `http://localhost:${process.env.API_PORT || process.env.PORT || 3000}` },
  },
});
