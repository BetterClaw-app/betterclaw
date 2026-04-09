import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ReactionTracker } from "../../src/reactions.js";
import type { ReactionEntry } from "../../src/types.js";
import { makeTmpDir } from "../helpers.js";

describe("ReactionTracker", () => {
  let tracker: ReactionTracker;

  beforeEach(() => {
    tracker = new ReactionTracker("/tmp/test-reactions");
  });

  it("records a push with pending status", () => {
    tracker.recordPush({
      subscriptionId: "default.battery-low",
      source: "device.battery",
      pushedAt: 1740000000,
      messageSummary: "Battery at 15%",
    });

    const recent = tracker.getPending();
    expect(recent).toHaveLength(1);
    expect(recent[0].status).toBe("pending");
    expect(recent[0].messageSummary).toBe("Battery at 15%");
  });

  it("classifies a reaction by subscriptionId + pushedAt compound key", () => {
    tracker.recordPush({
      subscriptionId: "test.battery",
      source: "device.battery",
      pushedAt: 1740000000,
      messageSummary: "Test push",
    });

    tracker.classify("test.battery", 1740000000, "engaged", "User asked follow-up about battery");

    const all = tracker.getRecent(24);
    expect(all[0].status).toBe("engaged");
    expect(all[0].classificationReason).toBe("User asked follow-up about battery");
    expect(all[0].classifiedAt).toBeGreaterThan(0);
  });

  it("does not misclassify when subscriptionId differs at same timestamp", () => {
    tracker.recordPush({
      subscriptionId: "sub.a",
      source: "device.battery",
      pushedAt: 1740000000,
      messageSummary: "Push A",
    });
    tracker.recordPush({
      subscriptionId: "sub.b",
      source: "device.battery",
      pushedAt: 1740000000,
      messageSummary: "Push B",
    });

    tracker.classify("sub.a", 1740000000, "engaged", "User engaged with A");

    const all = tracker.getRecent(24 * 365);
    const a = all.find((r) => r.subscriptionId === "sub.a");
    const b = all.find((r) => r.subscriptionId === "sub.b");
    expect(a!.status).toBe("engaged");
    expect(b!.status).toBe("pending");
  });

  it("rotates entries older than 30 days", () => {
    tracker.recordPush({
      subscriptionId: "old",
      source: "test",
      pushedAt: Date.now() / 1000 - 31 * 86400,
      messageSummary: "Old push",
    });
    tracker.recordPush({
      subscriptionId: "new",
      source: "test",
      pushedAt: Date.now() / 1000,
      messageSummary: "New push",
    });

    tracker.rotate();

    const all = tracker.getRecent(24 * 365);
    expect(all).toHaveLength(1);
    expect(all[0].subscriptionId).toBe("new");
  });

  it("getPending returns only unclassified entries within time window", () => {
    const now = Date.now() / 1000;
    tracker.recordPush({
      subscriptionId: "a",
      source: "test",
      pushedAt: now - 3600,
      messageSummary: "Push A",
    });
    tracker.recordPush({
      subscriptionId: "b",
      source: "test",
      pushedAt: now - 7200,
      messageSummary: "Push B",
    });
    tracker.classify("b", now - 7200, "ignored", "User changed topic");

    const pending = tracker.getPending(24);
    expect(pending).toHaveLength(1);
    expect(pending[0].subscriptionId).toBe("a");
  });
});

describe("ReactionTracker.save/load round-trip", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("betterclaw-reactions-rt-");
  });

  it("round-trips data correctly", async () => {
    const tracker = new ReactionTracker(tmpDir);
    tracker.recordPush({
      subscriptionId: "sub.a",
      source: "device.battery",
      pushedAt: 1740000000,
      messageSummary: "Battery low",
    });
    tracker.recordPush({
      subscriptionId: "sub.b",
      source: "health.summary",
      pushedAt: 1740000100,
      messageSummary: "Steps goal reached",
    });
    await tracker.save();

    const tracker2 = new ReactionTracker(tmpDir);
    await tracker2.load();
    const all = tracker2.getRecent();
    expect(all).toHaveLength(2);
    expect(all[0].subscriptionId).toBe("sub.a");
    expect(all[0].messageSummary).toBe("Battery low");
    expect(all[1].subscriptionId).toBe("sub.b");
    expect(all[1].messageSummary).toBe("Steps goal reached");
  });

  it("saves and loads empty tracker", async () => {
    const tracker = new ReactionTracker(tmpDir);
    await tracker.save();

    const tracker2 = new ReactionTracker(tmpDir);
    await tracker2.load();
    expect(tracker2.getRecent()).toHaveLength(0);
  });

  it("handles corrupt file on load gracefully", async () => {
    // Write corrupt JSONL content
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "push-reactions.jsonl"), "not valid json\n{broken\n", "utf8");

    const tracker = new ReactionTracker(tmpDir);
    await tracker.load();
    // Corrupt lines are silently dropped
    expect(tracker.getRecent()).toHaveLength(0);
  });

  it("preserves classified reactions through save/load", async () => {
    const tracker = new ReactionTracker(tmpDir);
    tracker.recordPush({
      subscriptionId: "sub.c",
      source: "device.battery",
      pushedAt: 1740000000,
      messageSummary: "Test push",
    });
    tracker.classify("sub.c", 1740000000, "engaged", "User asked follow-up");
    await tracker.save();

    const tracker2 = new ReactionTracker(tmpDir);
    await tracker2.load();
    const all = tracker2.getRecent();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("engaged");
    expect(all[0].classificationReason).toBe("User asked follow-up");
    expect(all[0].classifiedAt).toBeGreaterThan(0);
  });
});

describe("ReactionTracker.rotate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("betterclaw-reactions-rot-");
  });

  it("removes entries older than 30 days", () => {
    const tracker = new ReactionTracker(tmpDir);
    const now = Date.now() / 1000;
    tracker.recordPush({
      subscriptionId: "old",
      source: "test",
      pushedAt: now - 31 * 86400,
      messageSummary: "Old push",
    });
    tracker.recordPush({
      subscriptionId: "recent",
      source: "test",
      pushedAt: now - 1 * 86400,
      messageSummary: "Recent push",
    });

    tracker.rotate();

    const all = tracker.getRecent();
    expect(all).toHaveLength(1);
    expect(all[0].subscriptionId).toBe("recent");
  });

  it("no-op on empty tracker", () => {
    const tracker = new ReactionTracker(tmpDir);
    tracker.rotate();
    expect(tracker.getRecent()).toHaveLength(0);
  });

  it("keeps all entries when all are recent", () => {
    const tracker = new ReactionTracker(tmpDir);
    const now = Date.now() / 1000;
    for (let i = 0; i < 5; i++) {
      tracker.recordPush({
        subscriptionId: `sub-${i}`,
        source: "test",
        pushedAt: now - i * 86400,
        messageSummary: `Push ${i}`,
      });
    }

    tracker.rotate();
    expect(tracker.getRecent()).toHaveLength(5);
  });
});
