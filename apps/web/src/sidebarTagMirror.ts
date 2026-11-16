import {
  applySidebarTagOperation,
  type EnvironmentId,
  type SidebarTag,
  type SidebarTagOperation,
} from "@t3tools/contracts";

interface PendingOperation {
  readonly operation: SidebarTagOperation;
  acknowledged: boolean;
}

/**
 * Server tags with this client's unconfirmed operations on top. A snapshot can land before or
 * after its acknowledgement, so an acknowledged operation stays applied until the next snapshot.
 */
export function createSidebarTagMirror() {
  const server = new Map<EnvironmentId, readonly SidebarTag[]>();
  const pending = new Map<EnvironmentId, readonly PendingOperation[]>();
  return {
    /** Returns whether this snapshot changed anything. */
    receive: (environmentId: EnvironmentId, tags: readonly SidebarTag[]) => {
      if (server.get(environmentId) === tags) return false;
      server.set(environmentId, tags);
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
    begin: (environmentId: EnvironmentId, operation: SidebarTagOperation) => {
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
    tags: () =>
      [...server].map(
        ([environmentId, tags]) =>
          [
            environmentId,
            (pending.get(environmentId) ?? []).reduce(
              (current, { operation }) => applySidebarTagOperation(current, operation),
              tags,
            ),
          ] as const,
      ),
  };
}
