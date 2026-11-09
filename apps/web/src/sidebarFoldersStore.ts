import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type SidebarFolder as EnvironmentSidebarFolder,
  type SidebarFolderOperation,
} from "@t3tools/contracts";
import { create } from "zustand";

import { toastManager } from "./components/ui/toast";
import { randomUUID } from "./lib/utils";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { parseLegacySidebarFolders, planLegacySidebarFolderImport } from "./sidebarFolderImport";
import { createSidebarFolderMirror } from "./sidebarFolderMirror";
import { readPrimaryEnvironmentId } from "./state/environments";
import { environmentServerConfigsAtom, serverEnvironment } from "./state/server";

const LEGACY_STORAGE_KEY = "t3code:sidebar-folders:v1";
const COLLAPSED_STORAGE_KEY = "t3code:sidebar-folders-collapsed:v1";

export interface SidebarFolder {
  readonly id: string;
  readonly name: string;
  readonly collapsed: boolean;
}

interface SidebarFoldersStore {
  readonly folders: readonly SidebarFolder[];
  readonly folderIdByThreadKey: Readonly<Record<string, string>>;
  readonly environmentIdByFolderId: Readonly<Record<string, EnvironmentId>>;
  readonly createFolder: (environmentId: EnvironmentId | null) => string | null;
  readonly renameFolder: (folderId: string, name: string) => void;
  readonly toggleFolder: (folderId: string) => void;
  readonly deleteFolder: (folderId: string) => void;
  readonly moveThread: (threadKey: string, folderId: string | null) => void;
}

type ServerConfigs = ReadonlyMap<
  EnvironmentId,
  { readonly settings: { readonly sidebarFolders: readonly EnvironmentSidebarFolder[] } }
>;

function readJson(key: string): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const storedCollapsed = typeof window === "undefined" ? null : readJson(COLLAPSED_STORAGE_KEY);
const collapsedFolderIds = new Set<string>(
  Array.isArray(storedCollapsed) ? storedCollapsed.filter((id) => typeof id === "string") : [],
);
const mirror = createSidebarFolderMirror();

function publish() {
  const folders: SidebarFolder[] = [];
  const folderIdByThreadKey: Record<string, string> = {};
  const environmentIdByFolderId: Record<string, EnvironmentId> = {};
  for (const [environmentId, environmentFolders] of mirror.folders()) {
    for (const { id, name, threadIds } of environmentFolders) {
      folders.push({ id, name, collapsed: collapsedFolderIds.has(id) });
      environmentIdByFolderId[id] = environmentId;
      for (const threadId of threadIds) {
        folderIdByThreadKey[scopedThreadKey(scopeThreadRef(environmentId, threadId))] = id;
      }
    }
  }
  useSidebarFoldersStore.setState({ folders, folderIdByThreadKey, environmentIdByFolderId });
}

const saveCollapsed = () => writeLocal(COLLAPSED_STORAGE_KEY, [...collapsedFolderIds]);

function syncFromServer(configs: ServerConfigs) {
  let changed = mirror.retain(new Set(configs.keys()));
  for (const [environmentId, config] of configs) {
    if (mirror.receive(environmentId, config.settings.sidebarFolders)) changed = true;
  }
  if (changed) publish();
}

async function dispatch(
  environmentId: EnvironmentId,
  operation: SidebarFolderOperation,
  options: { readonly reportFailure: boolean } = { reportFailure: true },
) {
  const entry = mirror.begin(environmentId, operation);
  publish();
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSidebarFolders,
    { environmentId, input: operation },
    { label: "update folders", ...options },
  );
  if (result._tag === "Success") {
    mirror.acknowledge(entry);
    return true;
  }
  mirror.discard(environmentId, entry);
  publish();
  if (options.reportFailure) {
    toastManager.add({
      type: "error",
      title: "Could not update folders",
      description: "This server may need an update. Your change was not saved.",
    });
  }
  return false;
}

const canUpdateFolders = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(serverEnvironment.updateSidebarFolders.permissionAtom(environmentId));

function dispatchUserAction(environmentId: EnvironmentId, operation: SidebarFolderOperation) {
  if (canUpdateFolders(environmentId)) {
    void dispatch(environmentId, operation);
    return true;
  }
  toastManager.add({
    type: "error",
    title: "Folders unavailable",
    description: "This connection cannot change folders in this environment.",
  });
  return false;
}

// The hosted app has no primary environment, so the first connected one holds threadless folders.
const homeEnvironmentId = (configs: ServerConfigs) =>
  readPrimaryEnvironmentId() ?? configs.keys().next().value ?? null;

let importingLegacyFolders = false;
// Config pushes retrigger the import, so a server that rejected it waits for the next launch.
const rejectedImportEnvironmentIds = new Set<EnvironmentId>();
const permissionWatchedEnvironmentIds = new Set<EnvironmentId>();

async function importEnvironmentFolders(
  environmentId: EnvironmentId,
  operations: readonly SidebarFolderOperation[],
) {
  for (const operation of operations) {
    if (!(await dispatch(environmentId, operation, { reportFailure: false }))) return false;
  }
  return true;
}

async function importLegacyFolders(configs: ServerConfigs) {
  if (parseLegacySidebarFolders(readJson(LEGACY_STORAGE_KEY)) === null) return;
  // A session, and so the permission, loads after the first config, and no push has to follow it.
  for (const environmentId of configs.keys()) {
    if (permissionWatchedEnvironmentIds.has(environmentId)) continue;
    permissionWatchedEnvironmentIds.add(environmentId);
    appAtomRegistry.subscribe(
      serverEnvironment.updateSidebarFolders.permissionAtom(environmentId),
      () => void importLegacyFolders(appAtomRegistry.get(environmentServerConfigsAtom)),
    );
  }
  const home = homeEnvironmentId(configs);
  if (importingLegacyFolders || home === null) return;
  importingLegacyFolders = true;
  try {
    for (const environmentId of configs.keys()) {
      const legacy = parseLegacySidebarFolders(readJson(LEGACY_STORAGE_KEY));
      if (legacy === null) return;
      if (
        legacy.importedEnvironmentIds.includes(environmentId) ||
        rejectedImportEnvironmentIds.has(environmentId) ||
        !canUpdateFolders(environmentId)
      ) {
        continue;
      }
      const plan = planLegacySidebarFolderImport(legacy, environmentId, home);
      if (!(await importEnvironmentFolders(environmentId, plan.operations))) {
        rejectedImportEnvironmentIds.add(environmentId);
        continue;
      }
      for (const folderId of plan.collapsedFolderIds) collapsedFolderIds.add(folderId);
      saveCollapsed();
      publish();
      writeLocal(LEGACY_STORAGE_KEY, plan.remaining);
    }
  } finally {
    importingLegacyFolders = false;
  }
}

export const useSidebarFoldersStore = create<SidebarFoldersStore>((_set, get) => ({
  folders: [],
  folderIdByThreadKey: {},
  environmentIdByFolderId: {},
  createFolder: (environmentId) => {
    const target =
      environmentId ?? homeEnvironmentId(appAtomRegistry.get(environmentServerConfigsAtom));
    if (target === null) return null;
    const folderId = randomUUID();
    return dispatchUserAction(target, { action: "create", folderId, name: "New folder" })
      ? folderId
      : null;
  },
  renameFolder: (folderId, name) => {
    const environmentId = get().environmentIdByFolderId[folderId];
    if (environmentId !== undefined)
      dispatchUserAction(environmentId, { action: "rename", folderId, name });
  },
  toggleFolder: (folderId) => {
    if (!collapsedFolderIds.delete(folderId)) collapsedFolderIds.add(folderId);
    saveCollapsed();
    publish();
  },
  deleteFolder: (folderId) => {
    const environmentId = get().environmentIdByFolderId[folderId];
    if (environmentId === undefined) return;
    if (!dispatchUserAction(environmentId, { action: "delete", folderId })) return;
    if (collapsedFolderIds.delete(folderId)) saveCollapsed();
  },
  moveThread: (threadKey, folderId) => {
    const ref = parseScopedThreadKey(threadKey);
    if (ref === null || (get().folderIdByThreadKey[threadKey] ?? null) === folderId) return;
    if (folderId !== null && get().environmentIdByFolderId[folderId] !== ref.environmentId) {
      toastManager.add({
        type: "warning",
        title: "That folder is in another environment",
        description: "A thread can only join a folder in its own environment.",
      });
      return;
    }
    dispatchUserAction(ref.environmentId, {
      action: "move_threads",
      threadIds: [ref.threadId],
      folderId,
    });
  },
}));

if (typeof window !== "undefined") {
  appAtomRegistry.subscribe(
    environmentServerConfigsAtom,
    (configs) => {
      syncFromServer(configs);
      void importLegacyFolders(configs);
    },
    { immediate: true },
  );
}
