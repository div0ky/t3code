import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createSidebarFolderMirror } from "./sidebarFolderMirror";

const environmentId = EnvironmentId.make("environment");
const names = (mirror: ReturnType<typeof createSidebarFolderMirror>) =>
  mirror.folders()[0]?.[1].map((folder) => folder.name);

describe("createSidebarFolderMirror", () => {
  it("keeps an in-flight create and rename when an earlier create's snapshot lands", () => {
    const mirror = createSidebarFolderMirror();
    const first = mirror.begin(environmentId, { action: "create", folderId: "a", name: "A" });
    mirror.begin(environmentId, { action: "create", folderId: "b", name: "New folder" });
    mirror.begin(environmentId, { action: "rename", folderId: "b", name: "B" });

    mirror.acknowledge(first);
    mirror.receive(environmentId, [{ id: "a", name: "A", threadIds: [] }]);

    expect(names(mirror)).toEqual(["A", "B"]);
  });

  it("keeps an acknowledged move until its snapshot, then lets the server win", () => {
    const mirror = createSidebarFolderMirror();
    const threadId = ThreadId.make("thread");
    const empty = [{ id: "a", name: "A", threadIds: [] }];
    mirror.receive(environmentId, empty);
    const move = mirror.begin(environmentId, {
      action: "move_threads",
      threadIds: [threadId],
      folderId: "a",
    });
    mirror.acknowledge(move);
    expect(mirror.folders()[0]?.[1][0]?.threadIds).toEqual([threadId]);

    mirror.receive(environmentId, [{ id: "a", name: "A", threadIds: [] }]);
    expect(mirror.folders()[0]?.[1][0]?.threadIds).toEqual([]);
  });

  it("drops a failed operation", () => {
    const mirror = createSidebarFolderMirror();
    const create = mirror.begin(environmentId, { action: "create", folderId: "a", name: "A" });
    mirror.discard(environmentId, create);
    expect(names(mirror)).toEqual([]);
  });
});
