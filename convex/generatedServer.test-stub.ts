// Test-only stand-in for `convex/_generated/server`.
//
// Generated declarations are committed and provide the deploy-time types. This
// stub remains only for the test runtime: the convex-test module maps register a
// TypeScript entry for `./_generated/server.ts`, and the Vitest resolver sends
// generated-server imports here. It re-exports the same generic runtime builders
// as generated server.js without requiring generated JavaScript in that virtual
// module slot.
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
