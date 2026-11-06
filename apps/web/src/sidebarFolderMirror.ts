import {
  applySidebarFolderOperation,
  type EnvironmentId,
  type SidebarFolder,
  type SidebarFolderOperation,
} from "@t3tools/contracts";

interface PendingOperation {
  readonly operation: SidebarFolderOperation;
  acknowledged: boolean;
}

/**
 * Server folders with this client's unconfirmed operations on top. A snapshot can land before or
 * after its acknowledgement, so an acknowledged operation stays applied until the next snapshot.
 */
export function createSidebarFolderMirror() {
  const server = new Map<EnvironmentId, readonly SidebarFolder[]>();
  const pending = new Map<EnvironmentId, readonly PendingOperation[]>();
  return {
    /** Returns whether this snapshot changed anything. */
    receive: (environmentId: EnvironmentId, folders: readonly SidebarFolder[]) => {
      if (server.get(environmentId) === folders) return false;
      server.set(environmentId, folders);
      pending.set(
        environmentId,
        (pending.get(environmentId) ?? []).filter((entry) => !entry.acknowledged),
      );
      return true;
    },
    /** Returns whether any environment was dropped. */
    retain: (environmentIds: ReadonlySet<EnvironmentId>) => {
      let changed = false;
      for (const environmentId of server.keys()) {
        if (environmentIds.has(environmentId)) continue;
        server.delete(environmentId);
        pending.delete(environmentId);
        changed = true;
      }
      return changed;
    },
    begin: (environmentId: EnvironmentId, operation: SidebarFolderOperation) => {
      const entry: PendingOperation = { operation, acknowledged: false };
      if (!server.has(environmentId)) server.set(environmentId, []);
      pending.set(environmentId, [...(pending.get(environmentId) ?? []), entry]);
      return entry;
    },
    acknowledge: (entry: PendingOperation) => {
      entry.acknowledged = true;
    },
    discard: (environmentId: EnvironmentId, entry: PendingOperation) => {
      pending.set(
        environmentId,
        (pending.get(environmentId) ?? []).filter((candidate) => candidate !== entry),
      );
    },
    folders: () =>
      [...server].map(
        ([environmentId, folders]) =>
          [
            environmentId,
            (pending.get(environmentId) ?? []).reduce(
              (current, { operation }) => applySidebarFolderOperation(current, operation),
              folders,
            ),
          ] as const,
      ),
  };
}
