package com.sats21m.vogelvault.ui

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals

class VaultButtonSourcePolicyTest {
    /**
     * The ledger button draws its own container. Nothing in the app may reach
     * for the filled Material button, including the shared wrapper itself.
     */
    @Test
    fun `filled Material button is not imported anywhere`() {
        val directImports = mutableListOf<Path>()
        Files.walk(Path.of("src/main/kotlin")).use { paths ->
            paths
                .filter { path -> path.toString().endsWith(".kt") }
                .filter { path ->
                    Files.readAllLines(path).any { line ->
                        line == "import androidx.compose.material3.Button"
                    }
                }
                .forEach(directImports::add)
        }

        assertEquals(emptyList<Path>(), directImports.sorted())
    }
}
