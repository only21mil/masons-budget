import Foundation
import UIKit
import os

final class MC2FolderManager: ObservableObject {
    static let shared = MC2FolderManager()

    @Published private(set) var folderURL: URL?
    @Published private(set) var isAccessible: Bool = false

    private let bookmarkKey = "mc2_folder_bookmark"
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "MC2Folder")

    init() {
        restoreBookmark()
    }

    var folderDisplayPath: String {
        guard let url = folderURL else { return "Not selected" }
        return url.lastPathComponent
    }

    // MARK: - Bookmark persistence

    func saveBookmark(for url: URL) {
        guard url.startAccessingSecurityScopedResource() else {
            log.error("Failed to start security-scoped access for \(url.path)")
            return
        }
        defer { url.stopAccessingSecurityScopedResource() }

        do {
            let data = try url.bookmarkData(
                options: .minimalBookmark,
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
            let url = try URL(
                resolvingBookmarkData: data,
                options: [],
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
}

// MARK: - SwiftUI folder picker

import SwiftUI

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
