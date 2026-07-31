package com.sats21m.vogelvault.data

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpPosterTest {
    @Test
    fun `redirects are not followed and their bodies are discarded`() = runBlocking {
        val connection = FakeHttpConnection(302, "redirect body".toByteArray())
        val response = poster(connection).postJson("https://example.test/query", "{}")

        assertFalse(connection.instanceFollowRedirects)
        assertEquals(302, response.code)
        assertEquals("", response.body)
        assertFalse(connection.inputOpened)
    }

    @Test
    fun `401 preserves status and discards its untrusted body`() = runBlocking {
        val connection = FakeHttpConnection(401, "credential details".toByteArray())
        val response = poster(connection).postJson("https://example.test/query", "{}")

        assertEquals(401, response.code)
        assertEquals("", response.body)
        assertFalse(connection.inputOpened)
    }

    @Test
    fun `success body at limit is returned`() = runBlocking {
        val connection = FakeHttpConnection(200, "12345678".toByteArray())

        val response = poster(connection, maxResponseBytes = 8)
            .postJson("https://example.test/query", "{}")

        assertEquals(200, response.code)
        assertEquals("12345678", response.body)
    }

    @Test
    fun `declared oversized success body fails without reading it`() {
        val connection = FakeHttpConnection(
            responseCode = 200,
            responseBytes = "secret response".toByteArray(),
            declaredLength = 9,
        )

        val error = assertThrows(IOException::class.java) {
            runBlocking {
                poster(connection, maxResponseBytes = 8)
                    .postJson("https://example.test/private-path", "{}")
            }
        }

        assertEquals("response body exceeds limit", error.message)
        assertFalse(connection.inputOpened)
        assertTrue(connection.disconnected)
        assertFalse(error.message.orEmpty().contains("private-path"))
        assertFalse(error.message.orEmpty().contains("secret response"))
    }

    @Test
    fun `chunked oversized success body is bounded while streaming`() {
        val connection = FakeHttpConnection(
            responseCode = 200,
            responseBytes = "123456789".toByteArray(),
            declaredLength = -1,
        )

        val error = assertThrows(IOException::class.java) {
            runBlocking {
                poster(connection, maxResponseBytes = 8)
                    .postJson("https://example.test/query", "{}")
            }
        }

        assertEquals("response body exceeds limit", error.message)
        assertTrue(connection.inputOpened)
        assertTrue(connection.disconnected)
    }

    private fun poster(
        connection: FakeHttpConnection,
        maxResponseBytes: Int = 8,
    ): UrlConnectionHttpPoster = UrlConnectionHttpPoster(
        connectTimeoutMs = 10_000,
        readTimeoutMs = 20_000,
        maxResponseBytes = maxResponseBytes,
        connectionFactory = { connection },
    )
}

private class FakeHttpConnection(
    private val responseCode: Int,
    private val responseBytes: ByteArray,
    private val declaredLength: Long = responseBytes.size.toLong(),
) : HttpURLConnection(URL("https://example.test/query")) {
    private val requestBytes = ByteArrayOutputStream()

    var inputOpened = false
        private set
    var disconnected = false
        private set

    override fun getOutputStream() = requestBytes

    override fun getResponseCode(): Int = responseCode

    override fun getContentLengthLong(): Long = declaredLength

    override fun getInputStream(): ByteArrayInputStream {
        inputOpened = true
        return ByteArrayInputStream(responseBytes)
    }

    override fun disconnect() {
        disconnected = true
    }

    override fun usingProxy(): Boolean = false

    override fun connect() = Unit
}
