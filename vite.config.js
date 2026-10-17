import { defineConfig } from 'vite';

// GitHub Pages serves this repo from https://<user>.github.io/rose-garden/,
// so the PRODUCTION build needs every asset path prefixed with that repo
// name. Locally (`npm run dev` / `npm run preview`) base stays '/' so
// http://localhost:5173/... keeps working exactly as before.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/rose-garden/' : '/',
}));
