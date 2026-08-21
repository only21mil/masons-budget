import { readFileSync } from "node:fs"

import { expect, it } from "vitest"

it("keeps wide finance tables horizontally reachable", () => {
  const css = readFileSync(
    new URL("../src/renderer/styles/global.css", import.meta.url),
    "utf8",
  )
  const scrollRule = /\.vv-scroll\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""

  expect(scrollRule).toMatch(/\boverflow:\s*auto\s*;/)
})
