package com.sats21m.vogelvault.data

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets
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
class UrlConnectionHttpPoster internal constructor(
    private val connectTimeoutMs: Int,
    private val readTimeoutMs: Int,
    private val maxResponseBytes: Int,
    private val connectionFactory: (String) -> HttpURLConnection = { requestedUrl ->
        URI.create(requestedUrl).toURL().openConnection() as HttpURLConnection
    },
) : HttpPoster {

    constructor(
        connectTimeoutMs: Int = 10_000,
        readTimeoutMs: Int = 20_000,
    ) : this(connectTimeoutMs, readTimeoutMs, MAX_RESPONSE_BYTES)

    init {
        require(maxResponseBytes > 0) { "maxResponseBytes must be positive" }
    }

    override suspend fun postJson(url: String, body: String): HttpTextResponse =
        withContext(Dispatchers.IO) {
            val connection = connectionFactory(url)
            try {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.instanceFollowRedirects = false
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
                    val declaredLength = connection.contentLengthLong
                    if (declaredLength > maxResponseBytes) {
                        throw IOException("response body exceeds limit")
                    }
                    val bytes = connection.inputStream.use { input ->
                        val initialCapacity = declaredLength
                            .takeIf { it in 1..maxResponseBytes.toLong() }
                            ?.toInt()
                            ?: DEFAULT_BUFFER_BYTES
                        val output = ByteArrayOutputStream(initialCapacity)
                        val buffer = ByteArray(DEFAULT_BUFFER_BYTES)
                        var total = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            if (total > maxResponseBytes) {
                                throw IOException("response body exceeds limit")
                            }
                            output.write(buffer, 0, count)
                        }
                        output.toByteArray()
                    }
                    String(bytes, StandardCharsets.UTF_8)
                } else {
                    ""
                }

                HttpTextResponse(code, text)
            } finally {
                connection.disconnect()
            }
        }

    private companion object {
        // Convex row queries and the legacy whole-data-file endpoint share this
        // transport. Eight MiB leaves headroom for those JSON documents while
        // placing a firm ceiling on a malformed or hostile response.
        const val MAX_RESPONSE_BYTES = 8 * 1_024 * 1_024
        const val DEFAULT_BUFFER_BYTES = 4_096
    }
}
