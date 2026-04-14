import { describe, it, expect } from "vitest";
import { errorFields } from "../src/errors.js";

describe("errorFields", () => {
  it("extracts type, message, stack for plain Error", () => {
    const err = new Error("boom");
    const f = errorFields(err);
    expect(f["error.type"]).toBe("Error");
    expect(f["error.message"]).toBe("boom");
    expect(typeof f["error.stack"]).toBe("string");
  });

  it("reflects custom subclass name", () => {
    class MyErr extends Error {}
    expect(errorFields(new MyErr("x"))["error.type"]).toBe("MyErr");
  });

  it("handles string / number / object throws", () => {
    expect(errorFields("s")["error.type"]).toBe("string");
    expect(errorFields("s")["error.message"]).toBe("s");
    expect(errorFields(42)["error.type"]).toBe("number");
    expect(errorFields(42)["error.message"]).toBe("42");
    expect(errorFields({ x: 1 })["error.type"]).toBe("object");
  });

  it("recursively expands cause chain", () => {
    const root = new Error("root");
    const wrap = new Error("wrap", { cause: root });
    const f = errorFields(wrap);
    expect(f["error.message"]).toBe("wrap");
    expect((f["error.cause"] as Record<string, unknown>)["error.message"]).toBe("root");
  });

  it("omits stack key when absent", () => {
    expect(Object.keys(errorFields("plain")).includes("error.stack")).toBe(false);
  });

  it("handles circular cause chains without stack overflow", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as Error & { cause: unknown }).cause = b;
    (b as Error & { cause: unknown }).cause = a;
    const f = errorFields(a);
    expect(f["error.message"]).toBe("a");
    const bCause = f["error.cause"] as Record<string, unknown>;
    expect(bCause["error.message"]).toBe("b");
    const aAgain = bCause["error.cause"] as Record<string, unknown>;
    expect(aAgain["error.message"]).toBe("<cycle>");
  });

  it("caps cause chain depth at 8", () => {
    let head = new Error("head");
    for (let i = 0; i < 20; i++) {
      const wrap = new Error(`wrap-${i}`);
      (wrap as Error & { cause: unknown }).cause = head;
      head = wrap;
    }
    const f = errorFields(head);
    let cursor: Record<string, unknown> | undefined = f;
    let depth = 0;
    while (cursor && cursor["error.cause"]) {
      cursor = cursor["error.cause"] as Record<string, unknown>;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(8);
  });
});
