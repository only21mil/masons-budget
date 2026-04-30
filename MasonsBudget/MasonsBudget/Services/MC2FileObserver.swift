import Foundation
import Combine
import UIKit
import os

@MainActor
final class MC2FileObserver: ObservableObject {
    @Published private(set) var hasUnresolvedConflicts = false
    @Published private(set) var conflictFiles: [String] = []

    private var metadataQuery: NSMetadataQuery?
    private var debounceTask: Task<Void, Never>?
    private var sceneObservers: [Any] = []
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "MC2FileObserver")

    var onFilesChanged: (() async -> Void)?

    private let debounceInterval: TimeInterval = 0.5

    func startObserving(folderURL: URL) {
        stopObserving()

        let query = NSMetadataQuery()
        query.searchScopes = [NSMetadataQueryUbiquitousDataScope]
        query.predicate = NSPredicate(format: "%K BEGINSWITH %@",
                                       NSMetadataItemPathKey,
                                       folderURL.path)
        query.sortDescriptors = [NSSortDescriptor(key: NSMetadataItemFSContentChangeDateKey, ascending: false)]

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(queryDidUpdate(_:)),
            name: .NSMetadataQueryDidUpdate,
            object: query
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(queryDidFinishGathering(_:)),
            name: .NSMetadataQueryDidFinishGathering,
            object: query
        )

        query.start()
        metadataQuery = query
        log.info("Started observing \(folderURL.path)")

        observeSceneLifecycle()
    }

    func stopObserving() {
        metadataQuery?.stop()
        metadataQuery?.disableUpdates()
        NotificationCenter.default.removeObserver(self, name: .NSMetadataQueryDidUpdate, object: metadataQuery)
        NotificationCenter.default.removeObserver(self, name: .NSMetadataQueryDidFinishGathering, object: metadataQuery)
        metadataQuery = nil
        debounceTask?.cancel()
        debounceTask = nil

        for observer in sceneObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        sceneObservers.removeAll()
    }

    // MARK: - Query callbacks

    @objc private func queryDidFinishGathering(_ notification: Notification) {
        processQueryResults()
    }

    @objc private func queryDidUpdate(_ notification: Notification) {
        debounceTask?.cancel()
        debounceTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(Int(debounceInterval * 1000)))
            guard !Task.isCancelled else { return }
            processQueryResults()
        }
    }

    private func processQueryResults() {
        guard let query = metadataQuery else { return }
        query.disableUpdates()
        defer { query.enableUpdates() }

        var conflicts: [String] = []

        for i in 0..<query.resultCount {
            guard let item = query.result(at: i) as? NSMetadataItem else { continue }

            if let hasConflicts = item.value(forAttribute: NSMetadataUbiquitousItemHasUnresolvedConflictsKey) as? Bool,
               hasConflicts,
               let path = item.value(forAttribute: NSMetadataItemPathKey) as? String {
                let filename = (path as NSString).lastPathComponent
                conflicts.append(filename)
            }
        }

        let hadConflicts = hasUnresolvedConflicts
        conflictFiles = conflicts
        hasUnresolvedConflicts = !conflicts.isEmpty

        if !conflicts.isEmpty && !hadConflicts {
            log.warning("Unresolved iCloud conflicts: \(conflicts.joined(separator: ", "))")
        }

        log.info("MC2 files updated (\(query.resultCount) items, \(conflicts.count) conflicts)")

        Task { @MainActor in
            await onFilesChanged?()
        }
    }

    // MARK: - Scene lifecycle

    private func observeSceneLifecycle() {
        let foreground = NotificationCenter.default.addObserver(
            forName: UIScene.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.metadataQuery?.enableUpdates()
                self?.log.info("Resumed file observation")
            }
        }

        let background = NotificationCenter.default.addObserver(
            forName: UIScene.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.metadataQuery?.disableUpdates()
                self?.log.info("Suspended file observation")
            }
        }

        sceneObservers = [foreground, background]
    }

    // MARK: - Conflict resolution

    func resolveConflict(for fileURL: URL, keepCurrent: Bool) {
        do {
            let versions = NSFileVersion.unresolvedConflictVersionsOfItem(at: fileURL) ?? []

            if !keepCurrent, let winner = versions.first {
                try winner.replaceItem(at: fileURL, options: .byMoving)
            }

            for version in versions {
                version.isResolved = true
            }
            try NSFileVersion.removeOtherVersionsOfItem(at: fileURL)

            conflictFiles.removeAll { $0 == fileURL.lastPathComponent }
            hasUnresolvedConflicts = !conflictFiles.isEmpty
            log.info("Resolved conflict for \(fileURL.lastPathComponent)")
        } catch {
            log.error("Failed to resolve conflict: \(error.localizedDescription)")
        }
    }

    deinit {
        metadataQuery?.stop()
    }
}
