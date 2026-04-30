// Mason's Budget App — Sync event model
// Tracks all write operations for conflict resolution and audit.
// Each create/update/delete from any device is logged here.

import Foundation
import SwiftData

@Model
final class SyncEvent {
    @Attribute(.unique) var id: String
    var timestamp: Date
    var entity: String
    var operation: SyncOperation
    var entityId: String
    var deviceId: String
    var userId: String
    var checksum: String?

    init(
        id: String,
        timestamp: Date = .now,
        entity: String,
        operation: SyncOperation,
        entityId: String,
        deviceId: String,
        userId: String,
        checksum: String? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.entity = entity
        self.operation = operation
        self.entityId = entityId
        self.deviceId = deviceId
        self.userId = userId
        self.checksum = checksum
    }
}
