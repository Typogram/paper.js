import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // The site is one prerendered page, so it can be served from anywhere -
    // GitHub Pages, Cloudflare Pages, an S3 bucket.
    adapter: adapter({ fallback: '404.html' }),
    paths: {
      // Set BASE_PATH when deploying under a sub-path, e.g. GitHub Pages
      // project sites: BASE_PATH=/paper.js npm run build
      base: process.env.BASE_PATH || ''
    }
  }
};

export default config;
