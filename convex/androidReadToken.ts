// Keep this boundary aligned with ConvexReadBootstrapClient.isBoundedReadToken.
// A token that Android cannot decode must be rejected before a one-shot
// bootstrap is consumed.

const MIN_READ_TOKEN_BYTES = 32;
const MAX_READ_TOKEN_BYTES = 512;
const FIRST_PRINTABLE_NON_SPACE_ASCII = 0x21;
const LAST_PRINTABLE_ASCII = 0x7e;

/** Whether Android can safely accept and persist a server read token. */
export function isValidAndroidReadToken(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < MIN_READ_TOKEN_BYTES ||
    value.length > MAX_READ_TOKEN_BYTES
  ) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code < FIRST_PRINTABLE_NON_SPACE_ASCII ||
      code > LAST_PRINTABLE_ASCII
    ) {
      return false;
    }
  }

  return true;
}
