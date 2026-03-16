import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ReactionTracker } from "../src/reactions.js";

describe("ReactionTracker", () => {
  let tmpDir: string;
  let tracker: ReactionTracker;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-reactions-"));
    tracker = new ReactionTracker(tmpDir);
  });

  it("records a push", () => {
    const now = Math.floor(Date.now() / 1000);
    tracker.recordPush({
      idempotencyKey: "event-geo-1-1740000100",
      subscriptionId: "geo-1",
      source: "geofence.triggered",
      pushedAt: now,
    });
    const recent = tracker.getRecent(24);
    expect(recent).toHaveLength(1);
    expect(recent[0].engaged).toBeNull();
  });

  it("marks a push as engaged", () => {
    const now = Math.floor(Date.now() / 1000);
    tracker.recordPush({
      idempotencyKey: "event-geo-1-1740000100",
      subscriptionId: "geo-1",
      source: "geofence.triggered",
      pushedAt: now,
    });
    tracker.markEngaged("event-geo-1-1740000100", true);
    const recent = tracker.getRecent(24);
    expect(recent[0].engaged).toBe(true);
  });

  it("returns only recent reactions within hours window", () => {
    const now = Date.now() / 1000;
    tracker.recordPush({
      idempotencyKey: "old",
      subscriptionId: "x",
      source: "y",
      pushedAt: now - 86400 * 2, // 2 days ago
    });
    tracker.recordPush({
      idempotencyKey: "recent",
      subscriptionId: "x",
      source: "y",
      pushedAt: now - 3600, // 1 hour ago
    });
    const recent = tracker.getRecent(24);
    expect(recent).toHaveLength(1);
    expect(recent[0].idempotencyKey).toBe("recent");
  });

  it("persists and loads reactions", async () => {
    const now = Math.floor(Date.now() / 1000);
    tracker.recordPush({
      idempotencyKey: "key-1",
      subscriptionId: "geo-1",
      source: "geofence.triggered",
      pushedAt: now,
    });
    await tracker.save();

    const tracker2 = new ReactionTracker(tmpDir);
    await tracker2.load();
    expect(tracker2.getRecent(24 * 365)).toHaveLength(1);
  });
});
