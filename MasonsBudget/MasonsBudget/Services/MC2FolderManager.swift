import Foundation
#if canImport(UIKit)
import UIKit
#endif
import os

final class MC2FolderManager: ObservableObject {
    static let shared = MC2FolderManager()

    @Published private(set) var folderURL: URL?
    @Published private(set) var isAccessible: Bool = false
    @Published private(set) var iCloudAvailable: Bool = false

    private let bookmarkKey = "mc2_folder_bookmark"
    private let iCloudContainerID = "iCloud.com.sats21m.masonsbudget"
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "MC2Folder")

    init() {
        restoreBookmark()
        // If no bookmark saved yet, try iCloud auto-connect
        if folderURL == nil {
            autoConnectICloud()
        }
    }

    var folderDisplayPath: String {
        guard let url = folderURL else { return "Not connected" }
        return url.lastPathComponent
    }

    // MARK: - iCloud auto-connect

    /// Automatically connects to the iCloud Drive container, creating
    /// the Documents/MC2 folder if needed. No user interaction required.
    func autoConnectICloud() {
        guard let containerURL = FileManager.default.url(
            forUbiquityContainerIdentifier: iCloudContainerID
        ) else {
            iCloudAvailable = false
            log.warning("iCloud container not available — user may not be signed in to iCloud")
            return
        }

        iCloudAvailable = true
        let documentsURL = containerURL.appendingPathComponent("Documents")
        let mc2URL = documentsURL.appendingPathComponent("MC2")

        do {
            // Create Documents/MC2 inside the iCloud container if it doesn't exist
            if !FileManager.default.fileExists(atPath: mc2URL.path) {
                try FileManager.default.createDirectory(
                    at: mc2URL,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
                log.info("Created MC2 folder in iCloud: \(mc2URL.path)")
            }

            folderURL = mc2URL
            isAccessible = FileManager.default.isReadableFile(atPath: mc2URL.path)
            log.info("Auto-connected to iCloud MC2 folder: \(mc2URL.path), accessible=\(self.isAccessible)")
        } catch {
            log.error("Failed to create MC2 folder in iCloud: \(error.localizedDescription)")
            isAccessible = false
        }
    }

    // MARK: - Bookmark persistence (manual override)

    func saveBookmark(for url: URL) {
        guard url.startAccessingSecurityScopedResource() else {
            log.error("Failed to start security-scoped access for \(url.path)")
            return
        }
        defer { url.stopAccessingSecurityScopedResource() }

        do {
            #if os(macOS)
            let bookmarkOptions: URL.BookmarkCreationOptions = [.withSecurityScope]
            #else
            let bookmarkOptions: URL.BookmarkCreationOptions = .minimalBookmark
            #endif
            let data = try url.bookmarkData(
                options: bookmarkOptions,
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            UserDefaults.standard.set(data, forKey: bookmarkKey)
            folderURL = url
            isAccessible = true
            log.info("MC2 folder bookmarked: \(url.path)")
        } catch {
            log.error("Failed to create bookmark: \(error.localizedDescription)")
        }
    }

    func restoreBookmark() {
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey) else {
            folderURL = nil
            isAccessible = false
            return
        }

        do {
            var isStale = false
            #if os(macOS)
            let resolveOptions: URL.BookmarkResolutionOptions = [.withSecurityScope]
            #else
            let resolveOptions: URL.BookmarkResolutionOptions = []
            #endif
            let url = try URL(
                resolvingBookmarkData: data,
                options: resolveOptions,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )

            if isStale {
                log.warning("Bookmark is stale, re-saving")
                saveBookmark(for: url)
                return
            }

            guard url.startAccessingSecurityScopedResource() else {
                log.error("Failed to access bookmarked folder")
                isAccessible = false
                return
            }

            folderURL = url
            isAccessible = FileManager.default.isReadableFile(atPath: url.path)
            log.info("Restored MC2 folder: \(url.path), accessible=\(self.isAccessible)")
        } catch {
            log.error("Failed to resolve bookmark: \(error.localizedDescription)")
            folderURL = nil
            isAccessible = false
        }
    }

    func clearBookmark() {
        if let url = folderURL {
            url.stopAccessingSecurityScopedResource()
        }
        UserDefaults.standard.removeObject(forKey: bookmarkKey)
        folderURL = nil
        isAccessible = false
        log.info("MC2 folder bookmark cleared")
    }

    /// Reset to iCloud auto-connect after clearing a manual override
    func reconnectICloud() {
        clearBookmark()
        autoConnectICloud()
    }
}

// MARK: - SwiftUI folder picker (manual override)

import SwiftUI

#if os(iOS)
struct MC2FolderPicker: UIViewControllerRepresentable {
    let onPick: (URL) -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.directoryURL = FileManager.default.url(
            forUbiquityContainerIdentifier: nil
        )?.appendingPathComponent("Documents")
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick)
    }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: (URL) -> Void
        init(onPick: @escaping (URL) -> Void) { self.onPick = onPick }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            guard let url = urls.first else { return }
            onPick(url)
        }
    }
}
#endif
