/**
 * Serialize security-sensitive native confirmations.
 *
 * The renderer is not trusted to keep its own buttons disabled. A shared guard
 * in main prevents concurrent invokes from stacking modal dialogs or starting
 * a second confirmed lifecycle change while the first one is still finishing.
 */
export interface NativeConfirmationGuard {
  run<T>(busyResult: T, operation: () => Promise<T>): Promise<T>
}

export function createNativeConfirmationGuard(): NativeConfirmationGuard {
  let inFlight = false

  return {
    async run<T>(busyResult: T, operation: () => Promise<T>): Promise<T> {
      if (inFlight) return busyResult

      inFlight = true
      try {
        return await operation()
      } finally {
        inFlight = false
      }
    },
  }
}
