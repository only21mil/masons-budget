import { fileURLToPath } from "node:url"
import path from "node:path"

import { defineConfig } from "vitest/config"

const priceDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: priceDirectory,
  test: {
    include: ["price.test.tsx"],
    environment: "node",
    css: false,
  },
})
