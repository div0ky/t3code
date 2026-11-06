import { create } from "zustand";

import { randomUUID } from "./lib/utils";

const STORAGE_KEY = "t3code:sidebar-folders:v1";

export interface SidebarFolder {
  readonly id: string;
  readonly name: string;
  readonly collapsed: boolean;
}

export interface SidebarFoldersState {
  readonly folders: readonly SidebarFolder[];
  readonly folderIdByThreadKey: Readonly<Record<string, string>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function parseSidebarFolders(value: unknown): SidebarFoldersState {
  if (!isRecord(value)) return { folders: [], folderIdByThreadKey: {} };
  const folders = (Array.isArray(value.folders) ? value.folders : []).flatMap(
    (folder): SidebarFolder[] =>
      isRecord(folder) && typeof folder.id === "string" && typeof folder.name === "string"
        ? [{ id: folder.id, name: folder.name, collapsed: folder.collapsed === true }]
        : [],
  );
  const known = new Set(folders.map((folder) => folder.id));
  const assignments = isRecord(value.folderIdByThreadKey) ? value.folderIdByThreadKey : {};
  return {
    folders,
    folderIdByThreadKey: Object.fromEntries(
      Object.entries(assignments).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && known.has(entry[1]),
      ),
    ),
  };
}

function deleteSidebarFolder(state: SidebarFoldersState, folderId: string): SidebarFoldersState {
  return {
    folders: state.folders.filter((folder) => folder.id !== folderId),
    folderIdByThreadKey: Object.fromEntries(
      Object.entries(state.folderIdByThreadKey).filter(([, id]) => id !== folderId),
    ),
  };
}

function moveThreadToSidebarFolder(
  state: SidebarFoldersState,
  threadKey: string,
  folderId: string | null,
): SidebarFoldersState {
  if ((state.folderIdByThreadKey[threadKey] ?? null) === folderId) return state;
  const { [threadKey]: _previous, ...rest } = state.folderIdByThreadKey;
  return {
    ...state,
    folderIdByThreadKey: folderId === null ? rest : { ...rest, [threadKey]: folderId },
  };
}

function readPersisted(): SidebarFoldersState {
  try {
    return parseSidebarFolders(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return parseSidebarFolders(null);
  }
}

interface SidebarFoldersStore extends SidebarFoldersState {
  readonly createFolder: () => string;
  readonly renameFolder: (folderId: string, name: string) => void;
  readonly toggleFolder: (folderId: string) => void;
  readonly deleteFolder: (folderId: string) => void;
  readonly moveThread: (threadKey: string, folderId: string | null) => void;
}

const patchFolder = (
  state: SidebarFoldersState,
  folderId: string,
  patch: (folder: SidebarFolder) => SidebarFolder,
) => ({
  folders: state.folders.map((folder) => (folder.id === folderId ? patch(folder) : folder)),
});

// ponytail: folders live in this client's localStorage, so they do not reach other devices or the
// mobile app. Syncing means a server command and projection for folder state.
export const useSidebarFoldersStore = create<SidebarFoldersStore>((set) => ({
  ...(typeof window === "undefined" ? parseSidebarFolders(null) : readPersisted()),
  createFolder: () => {
    const id = randomUUID();
    set((state) => ({
      folders: [...state.folders, { id, name: "New folder", collapsed: false }],
    }));
    return id;
  },
  renameFolder: (folderId, name) =>
    set((state) => patchFolder(state, folderId, (folder) => ({ ...folder, name }))),
  toggleFolder: (folderId) =>
    set((state) =>
      patchFolder(state, folderId, (folder) => ({ ...folder, collapsed: !folder.collapsed })),
    ),
  deleteFolder: (folderId) => set((state) => deleteSidebarFolder(state, folderId)),
  moveThread: (threadKey, folderId) =>
    set((state) => moveThreadToSidebarFolder(state, threadKey, folderId)),
}));

useSidebarFoldersStore.subscribe(({ folders, folderIdByThreadKey }) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ folders, folderIdByThreadKey }));
  } catch {}
});
