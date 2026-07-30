import SwiftUI

/// Minimal app-like host for native Data Protection Keychain tests.
///
/// Apple derives a library's Keychain access from the main executable, so a
/// bare command-line `xctest` process cannot validate the production macOS
/// path. This host has no product behavior, network access, or credentials.
@main
struct KeychainTestHostApp: App {
    var body: some Scene {
        WindowGroup {
            EmptyView()
        }
    }
}
