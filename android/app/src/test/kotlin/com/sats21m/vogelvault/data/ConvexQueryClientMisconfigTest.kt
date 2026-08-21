package com.sats21m.vogelvault.data

import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Unauthorized now DESTROYS the stored credential, so its classification has to
 * be exact. The deployment throws "Unauthorized: ..." for two unrelated things:
 * a token the client got wrong, and the deployment's own CONVEX_READ_TOKEN
 * being unset. Only the first is a credential problem. Treating the second as
 * one would wipe a good token on every device the moment the backend was
 * misconfigured.
 */
class ConvexQueryClientMisconfigTest {
    @Test
    fun `a rejected token is Unauthorized`() {
        val result = classifyConvexError<Unit>("Unauthorized: invalid read token")
        assertTrue(result is ConvexResult.Unauthorized, "got $result")
    }

    @Test
    fun `a misconfigured deployment is not a credential rejection`() {
        val result = classifyConvexError<Unit>(
            "Unauthorized: CONVEX_READ_TOKEN is not configured (fail-closed). " +
                "Set the token on the deployment, or set ALLOW_TOKENLESS_READ=true.",
        )
        assertTrue(
            result is ConvexResult.Failed,
            "a server-side misconfiguration must not destroy the user's token, got $result",
        )
    }
}
