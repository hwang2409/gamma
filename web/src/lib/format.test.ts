import { describe, expect, it } from "vitest";

import { formatCount, formatSeconds, relativeTime, shortPath, toolTarget } from "./format";

describe("toolTarget", () => {
  it("prefers the most telling argument", () => {
    expect(toolTarget({ command: "pytest -q", timeout: 30 })).toBe("pytest -q");
    expect(toolTarget({ path: "src/app.py", limit: 10 })).toBe("src/app.py");
    expect(toolTarget({ url: "https://example.com" })).toBe("https://example.com");
  });

  it("keeps the first line of a multi-line value", () => {
    expect(toolTarget({ command: "cd x\nmake test" })).toBe("cd x …");
  });

  it("falls back to the first argument, then to nothing", () => {
    expect(toolTarget({ items: [1, 2] })).toBe("items=[1,2]");
    expect(toolTarget({})).toBe("");
  });
});

describe("shortPath", () => {
  it("replaces the home directory and trims long paths", () => {
    expect(shortPath("/Users/ada/code/gamma")).toBe("~/code/gamma");
    expect(shortPath("/home/ada/a/b/c/d/e")).toBe("…/c/d/e");
    expect(shortPath("/srv/app")).toBe("/srv/app");
    expect(shortPath(null)).toBe("");
  });
});

describe("formatSeconds", () => {
  it("scales the unit", () => {
    expect(formatSeconds(0.42)).toBe("0.4s");
    expect(formatSeconds(12.7)).toBe("12s");
    expect(formatSeconds(185)).toBe("3m 05s");
    expect(formatSeconds(3720)).toBe("1h 02m");
  });
});

describe("formatCount", () => {
  it("abbreviates large counts", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(1200)).toBe("1.2k");
    expect(formatCount(2000)).toBe("2k");
    expect(formatCount(34_400)).toBe("34k");
    expect(formatCount(1_500_000)).toBe("1.5M");
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2025, 0, 10, 12);
  it("reads like speech", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});
