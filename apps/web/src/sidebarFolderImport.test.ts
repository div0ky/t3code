import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planLegacySidebarFolderImport } from "./sidebarFolderImport";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");
const key = (environmentId: EnvironmentId, id: string) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));

describe("planLegacySidebarFolderImport", () => {
  const legacy = {
    folders: [
      { id: "mixed", name: "Mixed", collapsed: true },
      { id: "empty", name: "Empty", collapsed: false },
    ],
    folderIdByThreadKey: { [key(primary, "a")]: "mixed", [key(remote, "b")]: "mixed" },
    importedEnvironmentIds: [],
  };

  it("splits a cross-environment folder and finishes when every environment has imported", () => {
    const first = planLegacySidebarFolderImport(legacy, primary, primary);
    expect(first.operations).toEqual([
      { action: "create", folderId: "mixed", name: "Mixed" },
      { action: "move_threads", threadIds: ["a"], folderId: "mixed" },
      { action: "create", folderId: "empty", name: "Empty" },
    ]);
    expect(first.collapsedFolderIds).toEqual(["mixed"]);
    expect(first.remaining?.folderIdByThreadKey).toEqual({ [key(remote, "b")]: "mixed" });

    const second = planLegacySidebarFolderImport(first.remaining!, remote, primary);
    expect(second.operations).toEqual([
      { action: "create", folderId: "mixed:remote", name: "Mixed" },
      { action: "move_threads", threadIds: ["b"], folderId: "mixed:remote" },
    ]);
    expect(second.remaining).toBeNull();
  });

  it("keeps the local copy until the primary has imported", () => {
    const plan = planLegacySidebarFolderImport(
      { ...legacy, folderIdByThreadKey: { [key(remote, "b")]: "mixed" } },
      remote,
      primary,
    );
    expect(plan.remaining?.importedEnvironmentIds).toEqual(["remote"]);
  });
});
