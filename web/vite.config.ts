import { defineConfig } from "vite";

const publicSearchProxy = {
  "/api/bing-search": {
    target: "https://cn.bing.com",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/bing-search/, "/search"),
  },
  "/api/bbc-news": {
    target: "https://feeds.bbci.co.uk",
    changeOrigin: true,
    rewrite: () => "/news/rss.xml",
  },
};

export default defineConfig({
  server: {
    port: 8899,
    host: "127.0.0.1",
    strictPort: true,
    proxy: publicSearchProxy,
  },
  preview: {
    proxy: publicSearchProxy,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
