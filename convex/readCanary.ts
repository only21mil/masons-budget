import { ConvexError, v } from "convex/values";

import { query } from "./_generated/server";
import { timingSafeEqualStrings } from "./deviceAuth";

declare const process: { env: Record<string, string | undefined> };

function validateConfiguredReadToken(token?: string) {
  const expected = process.env.CONVEX_READ_TOKEN;
  if (!expected || !token || !timingSafeEqualStrings(token, expected)) {
    throw new ConvexError({
      code: "READ_UNAUTHORIZED",
      message: "Unauthorized read credential.",
    });
  }
}

/**
 * Authenticate the deployed read credential without touching household data.
 * This intentionally ignores every tokenless cutover hatch.
 */
export const check = query({
  args: { token: v.optional(v.string()) },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (_ctx, { token }) => {
    validateConfiguredReadToken(token);
    return { ok: true as const };
  },
});
