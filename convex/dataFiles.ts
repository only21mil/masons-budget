import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

function validateSyncToken(token?: string) {
  const expected = process.env.CONVEX_SYNC_TOKEN;
  if (!expected) return;
  if (!token || token !== expected) {
    throw new Error("Unauthorized: invalid sync token");
  }
}

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

const appTransactionValidator = v.object({
  id: v.string(),
  date: v.string(),
  merchant: v.string(),
  amount: v.float64(),
  category: v.string(),
  card: v.optional(v.union(v.string(), v.null())),
  note: v.optional(v.union(v.string(), v.null())),
});

const appTodoValidator = v.object({
  id: v.string(),
  title: v.optional(v.union(v.string(), v.null())),
  text: v.optional(v.union(v.string(), v.null())),
  project: v.optional(v.union(v.string(), v.null())),
  area: v.optional(v.union(v.string(), v.null())),
  category: v.optional(v.union(v.string(), v.null())),
  type: v.optional(v.union(v.string(), v.null())),
  due_date: v.optional(v.union(v.string(), v.null())),
  dueDate: v.optional(v.union(v.string(), v.null())),
  when: v.optional(v.union(v.string(), v.null())),
  priority: v.optional(v.float64()),
  flag: v.optional(v.boolean()),
  flagged: v.optional(v.boolean()),
  done: v.optional(v.boolean()),
  completed: v.optional(v.boolean()),
  status: v.optional(v.union(v.string(), v.null())),
  owner: v.optional(v.union(v.string(), v.null())),
  assignee: v.optional(v.union(v.string(), v.null())),
  created_by: v.optional(v.union(v.string(), v.null())),
  sync_source: v.optional(v.union(v.string(), v.null())),
  createdAt: v.optional(v.union(v.string(), v.null())),
  created: v.optional(v.union(v.string(), v.null())),
  updated_at: v.optional(v.union(v.string(), v.null())),
});

async function bumpSyncVersion(
  ctx: any,
  name: string,
  version: number,
  updatedAt: number,
) {
  const versionDoc = await ctx.db
    .query("syncVersions")
    .withIndex("by_name", (q: any) => q.eq("name", name))
    .first();

  if (versionDoc) {
    await ctx.db.patch(versionDoc._id, {
      version,
      updatedAt,
    });
  } else {
    await ctx.db.insert("syncVersions", {
      name,
      version,
      updatedAt,
    });
  }
}

/** Upsert a data file — replaces the entire payload and bumps the version. */
export const sync = mutation({
  args: {
    name: v.string(),
    data: v.any(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { name, data, token }) => {
    validateSyncToken(token);
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

    await bumpSyncVersion(ctx, name, nextVersion, now);

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
      }),
    ),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { files, token }) => {
    validateSyncToken(token);
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

      await bumpSyncVersion(ctx, file.name, nextVersion, now);

      results.push({ name: file.name, version: nextVersion });
    }

    return results;
  },
});

/** Upsert one app-created transaction into transactions.json and bump its version. */
export const appendTransaction = mutation({
  args: {
    name: v.optional(
      v.union(v.literal("transactions"), v.literal("mason-transactions")),
    ),
    transaction: appTransactionValidator,
    token: v.optional(v.string()),
  },
  handler: async (ctx, { name: fileName, transaction, token }) => {
    validateSyncToken(token);
    const name = fileName ?? "transactions";
    const now = Date.now();

    const existing = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();

    const currentData = existing?.data;
    const transactions = Array.isArray(currentData) ? [...currentData] : [];
    const existingIndex = transactions.findIndex(
      (item) =>
        item &&
        typeof item === "object" &&
        "id" in item &&
        item.id === transaction.id,
    );

    if (existingIndex >= 0) {
      transactions[existingIndex] = transaction;
    } else {
      transactions.push(transaction);
    }

    const nextVersion = (existing?.version ?? 0) + 1;

    if (existing) {
      await ctx.db.patch(existing._id, {
        data: transactions,
        version: nextVersion,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("dataFiles", {
        name,
        data: transactions,
        version: nextVersion,
        updatedAt: now,
      });
    }

    await bumpSyncVersion(ctx, name, nextVersion, now);

    return { name, version: nextVersion, id: transaction.id };
  },
});

/** Upsert one app-created todo into todos.json and bump its version. */
export const upsertTodo = mutation({
  args: {
    name: v.optional(v.literal("todos")),
    todo: appTodoValidator,
    token: v.optional(v.string()),
  },
  handler: async (ctx, { name: fileName, todo, token }) => {
    validateSyncToken(token);
    const name = fileName ?? "todos";
    const now = Date.now();

    const existing = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();

    const currentData = existing?.data;
    const currentTodos = Array.isArray(currentData)
      ? [...currentData]
      : currentData &&
          typeof currentData === "object" &&
          Array.isArray((currentData as any).todos)
        ? [...(currentData as any).todos]
        : [];

    const existingIndex = currentTodos.findIndex(
      (item) =>
        item && typeof item === "object" && "id" in item && item.id === todo.id,
    );

    const normalized = {
      ...todo,
      title: todo.title ?? todo.text ?? "Untitled task",
      text: todo.text ?? todo.title ?? "Untitled task",
      category: todo.category ?? "sats",
      type: todo.type ?? todo.category ?? "sats",
      status:
        todo.status ?? (todo.done || todo.completed ? "completed" : "pending"),
      owner: todo.owner ?? "victor",
      assignee: todo.assignee ?? todo.owner ?? "victor",
      created_by: todo.created_by ?? "vogel-vault",
      sync_source: todo.sync_source ?? "vogel-vault",
      updated_at: todo.updated_at ?? new Date(now).toISOString(),
    };

    if (existingIndex >= 0) {
      currentTodos[existingIndex] = normalized;
    } else {
      currentTodos.push(normalized);
    }

    const nextData =
      currentData &&
      typeof currentData === "object" &&
      !Array.isArray(currentData) &&
      Array.isArray((currentData as any).todos)
        ? { ...(currentData as any), todos: currentTodos }
        : currentTodos;

    const nextVersion = (existing?.version ?? 0) + 1;

    if (existing) {
      await ctx.db.patch(existing._id, {
        data: nextData,
        version: nextVersion,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("dataFiles", {
        name,
        data: nextData,
        version: nextVersion,
        updatedAt: now,
      });
    }

    await bumpSyncVersion(ctx, name, nextVersion, now);

    return { name, version: nextVersion, id: todo.id };
  },
});

/** Upsert one app-created BTC bill pay into bitcoin-bill-pays and bump its version. */
export const appendBillPay = mutation({
  args: {
    billPay: v.object({
      id: v.string(),
      date: v.string(),
      merchant: v.string(),
      category: v.string(),
      amount_usd: v.float64(),
      btc_spent: v.float64(),
      btc_price: v.optional(v.union(v.float64(), v.null())),
      platform: v.optional(v.union(v.string(), v.null())),
      note: v.optional(v.union(v.string(), v.null())),
      fee_usd: v.optional(v.union(v.float64(), v.null())),
      reference: v.optional(v.union(v.string(), v.null())),
      owner: v.optional(v.union(v.string(), v.null())),
    }),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { billPay, token }) => {
    validateSyncToken(token);
    const name = "bitcoin-bill-pays";
    const now = Date.now();

    const existing = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();

    const currentData = existing?.data;
    // bill pays file has { bill_pays: [...] } structure
    let wrapper: any = currentData && typeof currentData === "object" && !Array.isArray(currentData)
      ? { ...currentData }
      : { bill_pays: [] };

    const billPays = Array.isArray(wrapper.bill_pays) ? [...wrapper.bill_pays] : [];
    const existingIndex = billPays.findIndex(
      (item: any) => item && typeof item === "object" && "id" in item && item.id === billPay.id
    );

    if (existingIndex >= 0) {
      billPays[existingIndex] = billPay;
    } else {
      billPays.push(billPay);
    }
    wrapper.bill_pays = billPays;

    const nextVersion = (existing?.version ?? 0) + 1;

    if (existing) {
      await ctx.db.patch(existing._id, {
        data: wrapper,
        version: nextVersion,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("dataFiles", {
        name,
        data: wrapper,
        version: nextVersion,
        updatedAt: now,
      });
    }

    await bumpSyncVersion(ctx, name, nextVersion, now);

    return { name, version: nextVersion, id: billPay.id };
  },
});

/** Delete a data file. */
export const remove = mutation({
  args: { name: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { name, token }) => {
    validateSyncToken(token);
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
