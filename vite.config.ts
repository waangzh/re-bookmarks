import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  const isFirefox = mode === "firefox";

  return {
    plugins: [react(), tailwindcss()],
    base: "",
    root: resolve(__dirname, "src"),
    publicDir: resolve(__dirname, "public"),
    define: {
      __REMARKS_BROWSER_TARGET__: JSON.stringify(isFirefox ? "firefox" : "chromium"),
    },
    build: {
      outDir: resolve(__dirname, isFirefox ? "dist-firefox" : "dist"),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          popup: resolve(__dirname, "src/popup/index.html"),
          sidebar: resolve(__dirname, "src/sidebar/index.html"),
          options: resolve(__dirname, "src/options/index.html"),
          background: resolve(__dirname, "src/background/index.ts"),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name].[hash].js",
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
  };
});
