// The Vogel Vault — Legacy sync event model
// Retained in the SwiftData schema so existing installs can migrate safely.

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
        checksum: String? = nil,
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
