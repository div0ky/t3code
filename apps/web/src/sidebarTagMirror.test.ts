import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createSidebarTagMirror } from "./sidebarTagMirror";

const environmentId = EnvironmentId.make("environment");
const names = (mirror: ReturnType<typeof createSidebarTagMirror>) =>
  mirror.tags()[0]?.[1].map((tag) => tag.name);

describe("createSidebarTagMirror", () => {
  it("keeps an in-flight create and rename when an earlier create's snapshot lands", () => {
    const mirror = createSidebarTagMirror();
    const first = mirror.begin(environmentId, { action: "create", tagId: "a", name: "A" });
    mirror.begin(environmentId, { action: "create", tagId: "b", name: "New tag" });
    mirror.begin(environmentId, { action: "rename", tagId: "b", name: "B" });

    mirror.acknowledge(first);
    mirror.receive(environmentId, [{ id: "a", name: "A", threadIds: [] }]);

    expect(names(mirror)).toEqual(["A", "B"]);
  });

  it("keeps an acknowledged tagging until its snapshot, then lets the server win", () => {
    const mirror = createSidebarTagMirror();
    const threadId = ThreadId.make("thread");
    const empty = [{ id: "a", name: "A", threadIds: [] }];
    mirror.receive(environmentId, empty);
    const tagging = mirror.begin(environmentId, {
      action: "tag_threads",
      threadIds: [threadId],
      tagId: "a",
    });
    mirror.acknowledge(tagging);
    expect(mirror.tags()[0]?.[1][0]?.threadIds).toEqual([threadId]);

    mirror.receive(environmentId, [{ id: "a", name: "A", threadIds: [] }]);
    expect(mirror.tags()[0]?.[1][0]?.threadIds).toEqual([]);
  });

  it("drops a failed operation", () => {
    const mirror = createSidebarTagMirror();
    const create = mirror.begin(environmentId, { action: "create", tagId: "a", name: "A" });
    mirror.discard(environmentId, create);
    expect(names(mirror)).toEqual([]);
  });
});
