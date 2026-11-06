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
  return false;
}

let importingLegacyFolders = false;

async function importLegacyFolders(configs: ServerConfigs) {
  const primaryEnvironmentId = readPrimaryEnvironmentId();
  if (importingLegacyFolders || primaryEnvironmentId === null) return;
  importingLegacyFolders = true;
  try {
    for (const environmentId of configs.keys()) {
      const legacy = parseLegacySidebarFolders(readJson(LEGACY_STORAGE_KEY));
      if (legacy === null) return;
      if (legacy.importedEnvironmentIds.includes(environmentId)) continue;
      const plan = planLegacySidebarFolderImport(legacy, environmentId, primaryEnvironmentId);
      for (const operation of plan.operations) {
        // An older server rejects this; the local copy stays for a later attempt.
        if (!(await dispatch(environmentId, operation, { reportFailure: false }))) return;
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
    const target = environmentId ?? readPrimaryEnvironmentId();
    if (target === null) return null;
    const folderId = randomUUID();
    void dispatch(target, { action: "create", folderId, name: "New folder" });
    return folderId;
  },
  renameFolder: (folderId, name) => {
    const environmentId = get().environmentIdByFolderId[folderId];
    if (environmentId !== undefined)
      void dispatch(environmentId, { action: "rename", folderId, name });
  },
  toggleFolder: (folderId) => {
    if (!collapsedFolderIds.delete(folderId)) collapsedFolderIds.add(folderId);
    saveCollapsed();
    publish();
  },
  deleteFolder: (folderId) => {
    const environmentId = get().environmentIdByFolderId[folderId];
    if (environmentId === undefined) return;
    if (collapsedFolderIds.delete(folderId)) saveCollapsed();
    void dispatch(environmentId, { action: "delete", folderId });
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
    void dispatch(ref.environmentId, {
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
