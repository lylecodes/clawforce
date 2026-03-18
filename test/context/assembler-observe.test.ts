import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { renderObservedEvents } = await import("../../src/context/observed-events.js");
const { EventsNamespace } = await import("../../src/sdk/events.js");

let db: ReturnType<typeof getMemoryDb>;
const DOMAIN = "test-assemble-observe";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("observed_events in assembler", () => {
  it("renders observed events section when observe patterns match", async () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("budget.exceeded", { agent: "dev-1", overage: 200 }, { db });

    const result = renderObservedEvents(DOMAIN, ["budget.*"], 0, db);
    expect(result).toContain("## Observed Events");
    expect(result).toContain("budget.exceeded");
    expect(result).toContain("dev-1");
  });
});
