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
});
