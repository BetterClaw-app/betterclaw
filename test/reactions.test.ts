import { describe, it, expect, beforeEach } from "vitest";
import { ReactionTracker } from "../src/reactions.js";
import type { ReactionEntry } from "../src/types.js";

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
