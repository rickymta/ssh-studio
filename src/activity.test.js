import { describe, expect, it } from "vitest";
import { ACTIVITY_MAX, filterActivity, pruneActivity } from "./activity.js";

describe("activity log", () => {
  const now = Date.UTC(2026, 10, 20);
  const day = 86_400_000;
  it("drops expired or malformed entries and keeps the newest ones", () => {
    const list = [
      { message: "old", at: now - 31 * day },
      { message: "kept", at: now - 29 * day },
      { message: 42, at: now },
      null,
      { message: "no time" },
    ];
    expect(pruneActivity(list, now).map((e) => e.message)).toEqual(["kept"]);
    const many = Array.from({ length: ACTIVITY_MAX + 5 }, (_, i) => ({
      message: `#${i}`,
      at: now,
    }));
    const pruned = pruneActivity(many, now);
    expect(pruned).toHaveLength(ACTIVITY_MAX);
    expect(pruned.at(-1).message).toBe(`#${ACTIVITY_MAX + 4}`);
  });
  it("filters by level and searches message and source", () => {
    const list = [
      { message: "Đã kết nối", source: "web-01", level: "success", at: now },
      { message: "Kết nối thất bại", source: "db-01", level: "error", at: now },
    ];
    expect(filterActivity(list, "error", "")).toHaveLength(1);
    expect(filterActivity(list, "all", "WEB")[0].source).toBe("web-01");
    expect(filterActivity(list, "all", "  ")).toHaveLength(2);
  });
});
