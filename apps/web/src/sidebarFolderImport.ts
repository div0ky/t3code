import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, SidebarFolderOperation, ThreadId } from "@t3tools/contracts";

export interface LegacySidebarFolders {
  readonly folders: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly collapsed: boolean;
  }>;
  readonly folderIdByThreadKey: Readonly<Record<string, string>>;
  readonly importedEnvironmentIds: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function parseLegacySidebarFolders(value: unknown): LegacySidebarFolders | null {
  if (!isRecord(value) || !Array.isArray(value.folders)) return null;
  return {
    folders: value.folders.flatMap((folder) =>
      isRecord(folder) && typeof folder.id === "string" && typeof folder.name === "string"
        ? [{ id: folder.id, name: folder.name, collapsed: folder.collapsed === true }]
        : [],
    ),
    folderIdByThreadKey: isRecord(value.folderIdByThreadKey)
      ? (Object.fromEntries(
          Object.entries(value.folderIdByThreadKey).filter(
            ([, folderId]) => typeof folderId === "string",
          ),
        ) as Record<string, string>)
      : {},
    importedEnvironmentIds: Array.isArray(value.importedEnvironmentIds)
      ? value.importedEnvironmentIds.filter((id) => typeof id === "string")
      : [],
  };
}

/**
 * Folders used to span environments on one client. Each environment now gets its share of a folder,
 * and threadless folders go to the primary. `remaining` is null once nothing is left to import.
 */
export function planLegacySidebarFolderImport(
  legacy: LegacySidebarFolders,
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId,
) {
  const isPrimary = environmentId === primaryEnvironmentId;
  const threadIdsByFolderId = new Map<string, ThreadId[]>();
  const folderIdByThreadKey: Record<string, string> = {};
  for (const [key, folderId] of Object.entries(legacy.folderIdByThreadKey)) {
    const ref = parseScopedThreadKey(key);
    if (ref?.environmentId === environmentId) {
      threadIdsByFolderId.set(folderId, [
        ...(threadIdsByFolderId.get(folderId) ?? []),
        ref.threadId,
      ]);
    } else {
      folderIdByThreadKey[key] = folderId;
    }
  }
  const operations: SidebarFolderOperation[] = [];
  const collapsedFolderIds: string[] = [];
  for (const folder of legacy.folders) {
    const threadIds = threadIdsByFolderId.get(folder.id) ?? [];
    if (threadIds.length === 0 && !isPrimary) continue;
    const folderId = isPrimary ? folder.id : `${folder.id}:${environmentId}`;
    operations.push({ action: "create", folderId, name: folder.name });
    if (threadIds.length > 0) operations.push({ action: "move_threads", threadIds, folderId });
    if (folder.collapsed) collapsedFolderIds.push(folderId);
  }
  const importedEnvironmentIds = [...legacy.importedEnvironmentIds, environmentId];
  const liveFolderIds = new Set(legacy.folders.map((folder) => folder.id));
  const done =
    importedEnvironmentIds.includes(primaryEnvironmentId) &&
    Object.values(folderIdByThreadKey).every((folderId) => !liveFolderIds.has(folderId));
  return {
    operations,
    collapsedFolderIds,
    remaining: done ? null : { ...legacy, folderIdByThreadKey, importedEnvironmentIds },
  };
}
