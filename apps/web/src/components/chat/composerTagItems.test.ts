import { describe, expect, it } from "vite-plus/test";

import { matchComposerTagItems, spaceTakesTag } from "./composerTagItems";

describe("matchComposerTagItems", () => {
  it("puts the closest name first, then tags the thread lacks, and offers unsaved draft tags", () => {
    const items = matchComposerTagItems({
      tags: ["Active", "inactive", "Reactive"],
      applied: ["active", "Proactive"],
      query: "act",
    });

    expect(items.map((item) => [item.label, item.tagged])).toEqual([
      ["#Active", true],
      ["#inactive", false],
      ["#Reactive", false],
      ["#Proactive", true],
    ]);
    expect(
      matchComposerTagItems({ tags: ["Active", "Bugs"], applied: ["Active"], query: "" }).map(
        (item) => item.name,
      ),
    ).toEqual(["Bugs", "Active"]);
  });

  it.each([
    ["act", "Active", true],
    ["ACTIVE", "active", true],
    ["", "Active", false],
    ["act", "Reactive", false],
  ])("lets Space take the tag for %j against %j: %s", (query, name, expected) => {
    expect(spaceTakesTag(query, name)).toBe(expected);
  });
});
