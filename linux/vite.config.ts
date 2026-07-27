import { fileURLToPath } from "node:url"
import path from "node:path"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import electron from "vite-plugin-electron/simple"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const appVersion = process.env.npm_package_version ?? "0.1.0"

// The electron plugin builds main and preload through their own nested Vite
// configs, which do NOT inherit the top-level `define`. Share it explicitly or
// __APP_VERSION__ survives into the bundle as an undeclared global.
const sharedDefine = { __APP_VERSION__: JSON.stringify(appVersion) }

export default defineConfig(({ mode }) => {
  const isRelease = mode === "release"

  return {
    root: dirname,
    define: sharedDefine,
    resolve: {
      // The shared domain resolves as a real workspace package
      // (@vogel-vault/domain), not an alias, so Node and Vite agree on it and the
      // headless render tests can import exactly what the app imports.
      alias: {
        "@": path.join(dirname, "src"),
      },
    },
    plugins: [
      react(),
      electron({
        main: {
          entry: path.join(dirname, "electron/main.ts"),
          vite: {
            define: sharedDefine,
            build: {
              outDir: path.join(dirname, "dist-electron"),
              sourcemap: false,
              rollupOptions: { output: { format: "es", entryFileNames: "main.js" } },
            },
          },
        },
        preload: {
          input: path.join(dirname, "electron/preload.ts"),
          vite: {
            define: sharedDefine,
            build: {
              outDir: path.join(dirname, "dist-electron"),
              sourcemap: false,
              // A sandboxed preload MUST be CommonJS — Electron does not support
              // ESM preload scripts when sandbox is enabled. The .cjs extension is
              // required because this package is "type": "module".
              rollupOptions: { output: { format: "cjs", entryFileNames: "preload.cjs" } },
            },
          },
        },
      }),
    ],
    build: {
      outDir: path.join(dirname, "dist"),
      emptyOutDir: true,
      target: "chrome130",
      // Release packages must not disclose source maps. Ordinary CI/design builds
      // keep them because their screenshots harness is a developer-only artifact.
      sourcemap: isRelease ? false : true,
      rollupOptions: {
        input: isRelease
          ? path.join(dirname, "index.html")
          : {
              // index.html is the app. screenshots.html is a build-time design
              // harness and must never be included in a distributable package.
              index: path.join(dirname, "index.html"),
              screenshots: path.join(dirname, "screenshots.html"),
            },
      },
    },
    server: {
      port: 5273,
      strictPort: true,
    },
  }
})
