import { describe, it, expect, beforeEach } from "vitest";
import { loadJson, saveJson } from "./persist";

const KEY = "tosse:test:persist";

describe("persist", () => {
  beforeEach(() => localStorage.clear());

  it("loadJson returns the fallback when the key is absent", () => {
    expect(loadJson(KEY, { a: 1 })).toEqual({ a: 1 });
  });

  it("saveJson → loadJson round-trips an object", () => {
    saveJson(KEY, { x: [1, 2], y: "z" });
    expect(loadJson(KEY, {})).toEqual({ x: [1, 2], y: "z" });
  });

  it("loadJson returns the fallback on corrupt JSON", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadJson(KEY, { fallback: true })).toEqual({ fallback: true });
  });

  it("loadJson returns the fallback when the stored value is not an object (e.g. a bare number)", () => {
    localStorage.setItem(KEY, "42");
    expect(loadJson(KEY, { ok: 1 })).toEqual({ ok: 1 });
  });
});
