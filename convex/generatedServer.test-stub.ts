// Test-only stand-in for `convex/_generated/server`.
//
// WHY THIS EXISTS: `convex/_generated/` is gitignored and `npx convex codegen`
// requires an authenticated deployment, so a fresh clone (and every CI runner)
// has no generated module for `dataFiles.ts` to import. Rather than make the
// test suite depend on network access to the production deployment, the vitest
// config resolves `./_generated/server` to this file. It re-exports the exact
// generic builders that codegen re-exports, so the functions under test are the
// real ones — only their type parameters are unbound.
//
// The two dots in this filename keep the Convex bundler from ever pushing it:
// entry-point collection skips any file whose basename contains more than one
// dot. Same reason every test file here is named `*.test.ts`.
import {
  actionGeneric,
  httpActionGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";

export const query = queryGeneric;
export const internalQuery = internalQueryGeneric;
export const mutation = mutationGeneric;
export const internalMutation = internalMutationGeneric;
export const action = actionGeneric;
export const internalAction = internalActionGeneric;
export const httpAction = httpActionGeneric;
