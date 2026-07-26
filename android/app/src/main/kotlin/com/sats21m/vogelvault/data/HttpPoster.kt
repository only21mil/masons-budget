package com.sats21m.vogelvault.data

import java.net.HttpURLConnection
import java.net.URI
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A JSON POST and what came back. */
class HttpTextResponse(val code: Int, val body: String)

/**
 * The one place this package touches the network.
 *
 * An interface so [ConvexQueryClient] — where the token attachment, the kill
 * switch and the envelope handling live — is testable on a plain JVM with no
 * sockets, no emulator and no deployment.
 */
interface HttpPoster {
    suspend fun postJson(url: String, body: String): HttpTextResponse
}

/**
 * `HttpURLConnection`, because it is in the platform.
 *
 * OkHttp or Retrofit would be the usual answer, and both would mean a new Gradle
 * dependency for a feature that is off by default and unwired. Convex's HTTP
 * query API is one POST with a JSON body; the platform client covers it.
 *
 * Timeouts are set explicitly: the defaults are "wait forever", which on a phone
 * means a spinner that never resolves when the deployment is unreachable.
 */
class UrlConnectionHttpPoster(
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 20_000,
) : HttpPoster {

    override suspend fun postJson(url: String, body: String): HttpTextResponse =
        withContext(Dispatchers.IO) {
            val connection = URI.create(url).toURL().openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.connectTimeout = connectTimeoutMs
                connection.readTimeout = readTimeoutMs
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Accept", "application/json")

                connection.outputStream.use { stream ->
                    stream.write(body.toByteArray(Charsets.UTF_8))
                }

                val code = connection.responseCode
                // Only a success body is read. Convex reports application errors
                // as HTTP 200 with `status: "error"`, so a non-200 is infra —
                // a proxy or captive portal — and its body is untrusted noise we
                // have no use for and would rather not hold in memory.
                val text = if (code in 200..299) {
                    connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                } else {
                    ""
                }

                HttpTextResponse(code, text)
            } finally {
                connection.disconnect()
            }
        }
}
