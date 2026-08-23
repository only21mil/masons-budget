package com.sats21m.vogelvault.ui

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals

class VaultButtonSourcePolicyTest {
    @Test
    fun `filled Material button is imported only by the shared wrapper`() {
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

        assertEquals(
            listOf(Path.of("src/main/kotlin/com/sats21m/vogelvault/ui/VaultButton.kt")),
            directImports.sorted(),
        )
    }
}
