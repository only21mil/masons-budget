import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

// A refresh mutates only the operational quote cache. Each upstream request is
// fixed and bounded; per-symbol failures preserve prior successful observations.
crons.interval(
  "refresh fixed market quote snapshot",
  { minutes: 15 },
  internal.marketQuotes.refresh,
  {},
);

export default crons;
