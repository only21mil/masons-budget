import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The Vogel Vault — Convex Schema
// Stores MC2 financial data synced from mission-control JSON files.
// Each "data file" is stored as a document with its raw JSON payload.
// This preserves the exact MC2 format the iOS app already decodes.

export default defineSchema({
  // ── Core data store ──
  // Each MC2 JSON file maps to one document.
  // The `data` field holds the raw JSON payload (array or object).
  dataFiles: defineTable({
    name: v.string(), // e.g. "transactions", "budget", "btc-balance-snapshot"
    data: v.any(), // Raw JSON — decoded client-side by Swift DTOs
    version: v.float64(), // Monotonically increasing — triggers client re-fetch
    updatedAt: v.float64(), // Unix timestamp (ms)
  }).index("by_name", ["name"]),

  // ── Sync metadata ──
  // Lightweight table the app polls to detect changes.
  // One document per data file tracks its current version.
  syncVersions: defineTable({
    name: v.string(),
    version: v.float64(),
    updatedAt: v.float64(),
  }).index("by_name", ["name"]),

  // ── Todo delete tombstones (SAT-1327) ──
  // A deleted todo is recorded here so the MC2 sync bridge can remove it locally
  // and a later pull cannot resurrect it. Kept in a SEPARATE table (not in the
  // todos payload) so the app-facing `get("todos")` response stays clean.
  todoTombstones: defineTable({
    id: v.string(), // the deleted todo's id
    deletedAt: v.float64(), // Unix timestamp (ms) of the delete
  }).index("by_todo_id", ["id"]),
});
