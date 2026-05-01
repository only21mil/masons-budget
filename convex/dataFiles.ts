import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

// ── Queries (called by the iOS app) ──

/** Fetch a single data file by name. Returns the raw JSON data. */
export const get = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const doc = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    return doc?.data ?? null;
  },
});

/** Fetch current versions of all data files — lightweight check for changes. */
export const getVersions = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("syncVersions").collect();
    return Object.fromEntries(docs.map((d) => [d.name, d.version]));
  },
});

/** List all available data file names. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("dataFiles").collect();
    return docs.map((d) => ({
      name: d.name,
      version: d.version,
      updatedAt: d.updatedAt,
    }));
  },
});

// ── Mutations (called by the MC2 sync script) ──

/** Upsert a data file — replaces the entire payload and bumps the version. */
export const sync = mutation({
  args: {
    name: v.string(),
    data: v.any(),
  },
  handler: async (ctx, { name, data }) => {
    const now = Date.now();

    // Upsert the data file
    const existing = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();

    const nextVersion = (existing?.version ?? 0) + 1;

    if (existing) {
      await ctx.db.patch(existing._id, {
        data,
        version: nextVersion,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("dataFiles", {
        name,
        data,
        version: nextVersion,
        updatedAt: now,
      });
    }

    // Update the sync version tracker
    const versionDoc = await ctx.db
      .query("syncVersions")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();

    if (versionDoc) {
      await ctx.db.patch(versionDoc._id, {
        version: nextVersion,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("syncVersions", {
        name,
        version: nextVersion,
        updatedAt: now,
      });
    }

    return { name, version: nextVersion };
  },
});

/** Sync multiple files in a single transaction. */
export const syncBatch = mutation({
  args: {
    files: v.array(
      v.object({
        name: v.string(),
        data: v.any(),
      })
    ),
  },
  handler: async (ctx, { files }) => {
    const now = Date.now();
    const results: { name: string; version: number }[] = [];

    for (const file of files) {
      const existing = await ctx.db
        .query("dataFiles")
        .withIndex("by_name", (q) => q.eq("name", file.name))
        .first();

      const nextVersion = (existing?.version ?? 0) + 1;

      if (existing) {
        await ctx.db.patch(existing._id, {
          data: file.data,
          version: nextVersion,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("dataFiles", {
          name: file.name,
          data: file.data,
          version: nextVersion,
          updatedAt: now,
        });
      }

      // Update sync version
      const versionDoc = await ctx.db
        .query("syncVersions")
        .withIndex("by_name", (q) => q.eq("name", file.name))
        .first();

      if (versionDoc) {
        await ctx.db.patch(versionDoc._id, {
          version: nextVersion,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("syncVersions", {
          name: file.name,
          version: nextVersion,
          updatedAt: now,
        });
      }

      results.push({ name: file.name, version: nextVersion });
    }

    return results;
  },
});

/** Delete a data file. */
export const remove = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const doc = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (doc) {
      await ctx.db.delete(doc._id);
    }

    const versionDoc = await ctx.db
      .query("syncVersions")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (versionDoc) {
      await ctx.db.delete(versionDoc._id);
    }
  },
});
