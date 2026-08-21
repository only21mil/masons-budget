import { fileURLToPath } from "node:url"
import path from "node:path"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

const dirname = path.dirname(fileURLToPath(import.meta.url))

// Deliberately separate from vite.config.ts: the app config carries the electron
// plugin, which would try to build main/preload on every test run. Tests only
// need the JSX transform and the workspace resolution.
export default defineConfig({
  root: dirname,
  plugins: [react()],
  resolve: {
    alias: { "@": path.join(dirname, "src") },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    css: false,
  },
})
