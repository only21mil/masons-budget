#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

const DEFAULT_MC2_PATH = "/home/victor/projects/mission-control";
const DEFAULT_CONVEX_URL = "https://keen-elephant-452.convex.cloud";
const SATS_TODO_OWNERS = new Set(["sats", "hermes", "sats-hermes", "sats hermes"]);
const FAMILY_MEMBERS = new Set(["victor", "rachel", "mason", "maddox"]);

function usage() {
  return `Usage: node scripts/canary-todo-sync.mjs [--mc2-path PATH] [--convex-url URL] [--skip-live] [--json]

Checks the mobile-visible todo sync surface without doing any writes:
  1. reads MC2 todos.json (array or { todos: [...] });
  2. normalizes records the same way the iOS DTO/mapper does for mobile visibility;
  3. optionally reads Convex dataFiles:get("todos") and compares normalized digests.

The report intentionally prints counts/digests only, not todo titles.`;
}

function parseArgs(argv) {
  const options = {
    mc2Path: process.env.MC2_PATH || DEFAULT_MC2_PATH,
    convexUrl: process.env.CONVEX_URL || DEFAULT_CONVEX_URL,
    skipLive: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mc2-path") options.mc2Path = argv[++i];
    else if (arg === "--convex-url") options.convexUrl = argv[++i];
    else if (arg === "--skip-live") options.skipLive = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function unwrapTodos(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.todos)) return raw.todos;
  return [];
}

function flexibleString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function effectiveOwner(todo) {
  const raw = flexibleString(todo.owner) ?? flexibleString(todo.assignee);
  if (!raw) return "victor";
  const normalized = raw.toLowerCase();
  if (SATS_TODO_OWNERS.has(normalized)) return "victor";
  if (FAMILY_MEMBERS.has(normalized)) return normalized;
  return null;
}

function effectiveDone(todo) {
  if (typeof todo.completed === "boolean") return todo.completed;
  if (typeof todo.done === "boolean") return todo.done;
  const status = flexibleString(todo.status)?.toLowerCase() ?? "";
  return status === "completed" || status === "done";
}

function effectiveTitle(todo) {
  const title = flexibleString(todo.title);
  if (title && title.length > 0) return title;
  const text = flexibleString(todo.text);
  if (text && text.length > 0) return text;
  return "Untitled task";
}

function effectiveProject(todo) {
  return flexibleString(todo.project) ?? flexibleString(todo.category) ?? flexibleString(todo.type) ?? null;
}

function effectiveDueDate(todo) {
  return flexibleString(todo.due_date)
    ?? flexibleString(todo.dueDate)
    ?? flexibleString(todo.due)
    ?? flexibleString(todo.date)
    ?? flexibleString(todo.deadline)
    ?? flexibleString(todo.when)
    ?? null;
}

function effectiveUpdatedAt(todo) {
  return flexibleString(todo.updated_at) ?? flexibleString(todo.updatedAt) ?? null;
}

function normalizeTodos(rawTodos) {
  const issues = [];
  const ids = new Map();
  const normalized = [];

  rawTodos.forEach((todo, index) => {
    if (!todo || typeof todo !== "object" || Array.isArray(todo)) {
      issues.push({ level: "error", code: "invalid_record", index });
      return;
    }

    const id = flexibleString(todo.id);
    if (!id) {
      issues.push({ level: "error", code: "missing_id", index });
      return;
    }

    ids.set(id, (ids.get(id) ?? 0) + 1);
    const owner = effectiveOwner(todo);
    if (!owner) {
      issues.push({ level: "warn", code: "non_family_owner", id });
      return;
    }

    normalized.push({
      id,
      owner,
      title: effectiveTitle(todo),
      project: effectiveProject(todo),
      dueDate: effectiveDueDate(todo),
      done: effectiveDone(todo),
      flagged: Boolean(todo.flagged ?? todo.flag ?? false),
      priority: typeof todo.priority === "number" ? todo.priority : Number.parseInt(flexibleString(todo.priority) ?? "0", 10) || 0,
      updatedAt: effectiveUpdatedAt(todo),
    });
  });

  for (const [id, count] of ids) {
    if (count > 1) issues.push({ level: "error", code: "duplicate_id", id, count });
  }

  normalized.sort((a, b) => a.id.localeCompare(b.id));
  return { normalized, issues };
}

function mobileVisible(normalized) {
  // Mirrors MC2Mapper.mapTodos today: the mobile todo feed keeps Victor-owned
  // family/Sats todos and excludes child/private non-Victor todos.
  return normalized.filter((todo) => todo.owner === "victor");
}

function digest(todos) {
  return crypto.createHash("sha256").update(JSON.stringify(todos)).digest("hex");
}

function summarize(rawTodos, normalized, visible, issues) {
  const unknownOwner = issues.filter((issue) => issue.code === "non_family_owner").length;
  return {
    rawCount: rawTodos.length,
    normalizedCount: normalized.length,
    mobileVisibleCount: visible.length,
    pendingVisibleCount: visible.filter((todo) => !todo.done).length,
    doneVisibleCount: visible.filter((todo) => todo.done).length,
    missingUpdatedAtCount: visible.filter((todo) => !todo.updatedAt).length,
    unknownOwnerCount: unknownOwner,
    errorCount: issues.filter((issue) => issue.level === "error").length,
    digest: digest(visible),
  };
}

async function fetchConvexTodos(convexUrl) {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is unavailable; use Node 18+ or run with --skip-live");
  }

  const url = new URL("api/query", convexUrl.endsWith("/") ? convexUrl : `${convexUrl}/`);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "dataFiles:get",
      args: { name: "todos" },
      format: "json",
    }),
  });

  if (!response.ok) throw new Error(`Convex HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope.status !== "success") {
    throw new Error(envelope.errorMessage || "Convex query failed");
  }
  return unwrapTodos(envelope.value);
}

function printReport(report, asJson) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("VogelVault mobile todo-sync canary");
  console.log(`MC2 todos: raw=${report.local.rawCount} normalized=${report.local.normalizedCount} mobile_visible=${report.local.mobileVisibleCount} pending=${report.local.pendingVisibleCount} done=${report.local.doneVisibleCount}`);
  console.log(`MC2 digest: ${report.local.digest}`);
  console.log(`MC2 issues: errors=${report.local.errorCount} unknown_owner=${report.local.unknownOwnerCount} missing_visible_updated_at=${report.local.missingUpdatedAtCount}`);
  if (report.live) {
    console.log(`Convex todos: raw=${report.live.rawCount} normalized=${report.live.normalizedCount} mobile_visible=${report.live.mobileVisibleCount} pending=${report.live.pendingVisibleCount} done=${report.live.doneVisibleCount}`);
    console.log(`Convex digest: ${report.live.digest}`);
    console.log(`Convex comparison: ${report.comparison}`);
  } else {
    console.log(`Convex comparison: ${report.comparison}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const todosPath = path.join(options.mc2Path, "todos.json");
  const localRawTodos = unwrapTodos(readJson(todosPath));
  const localNormalized = normalizeTodos(localRawTodos);
  const localVisible = mobileVisible(localNormalized.normalized);
  const report = {
    mc2Path: todosPath,
    convexUrl: options.skipLive ? null : options.convexUrl,
    local: summarize(localRawTodos, localNormalized.normalized, localVisible, localNormalized.issues),
    comparison: "skipped-live",
  };

  let exitCode = report.local.errorCount > 0 ? 1 : 0;

  if (!options.skipLive) {
    try {
      const liveRawTodos = await fetchConvexTodos(options.convexUrl);
      const liveNormalized = normalizeTodos(liveRawTodos);
      const liveVisible = mobileVisible(liveNormalized.normalized);
      report.live = summarize(liveRawTodos, liveNormalized.normalized, liveVisible, liveNormalized.issues);
      const match = report.local.digest === report.live.digest;
      report.comparison = match ? "match" : "mismatch";
      if (!match || report.live.errorCount > 0) exitCode = 1;
    } catch (error) {
      report.comparison = `live-check-failed: ${error.message}`;
      exitCode = 1;
    }
  }

  printReport(report, options.json);
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
