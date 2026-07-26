import { defineConfig } from "vitest/config";

// `dataFiles.ts` imports `./_generated/server`, which is gitignored and can only
// be produced by an authenticated `npx convex codegen`. Redirecting that one
// specifier at resolve time is what lets the suite run on a bare clone and in CI
// without ever touching the live deployment.
const generatedServerStub = new URL(
  "./generatedServer.test-stub.ts",
  import.meta.url,
).pathname;

export default defineConfig({
  // Pinned so `vitest run --config convex/vitest.config.ts` from the repo root
  // does not pick up the node:test suites under shared/domain/.
  root: new URL(".", import.meta.url).pathname,
  plugins: [
    {
      name: "convex-generated-server-stub",
      enforce: "pre",
      resolveId(source: string) {
        return source === "./_generated/server" ||
          source.endsWith("/_generated/server")
          ? generatedServerStub
          : null;
      },
    },
  ],
  test: {
    // convex-test runs the functions in a mock of the Convex runtime; the
    // edge-runtime environment is what the Convex docs prescribe so that a
    // Node-only API sneaking into a function fails here rather than on deploy.
    environment: "edge-runtime",
    include: ["**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
