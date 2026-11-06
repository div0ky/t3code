import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const LEGACY_KEY = "t3code:sidebar-folders:v1";
const first = EnvironmentId.make("first");
const second = EnvironmentId.make("second");
const thread = ThreadId.make("thread");

const state = vi.hoisted(() => ({
  configs: new Map<string, unknown>(),
  allowed: new Set<string>(),
  rejected: new Set<string>(),
  sent: [] as Array<{ environmentId: string; input: { action: string } }>,
  toasts: [] as Array<{ title: string }>,
  notify: (_configs: unknown) => {},
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: async (
    _registry: unknown,
    _command: unknown,
    request: { environmentId: string; input: { action: string } },
  ) => {
    state.sent.push(request);
    return { _tag: state.rejected.has(request.environmentId) ? "Failure" : "Success" };
  },
}));
vi.mock("./rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => (typeof atom === "string" ? state.allowed.has(atom) : state.configs),
    subscribe: (_atom: unknown, listener: (configs: unknown) => void) => {
      state.notify = listener;
    },
  },
}));
vi.mock("./state/server", () => ({
  environmentServerConfigsAtom: { name: "configs" },
  serverEnvironment: { updateSidebarFolders: { permissionAtom: (id: string) => id } },
}));
vi.mock("./state/environments", () => ({ readPrimaryEnvironmentId: () => null }));
vi.mock("./components/ui/toast", () => ({
  toastManager: { add: (toast: { title: string }) => state.toasts.push(toast) },
}));

async function setup(legacy?: unknown) {
  state.configs.clear();
  state.allowed.clear();
  state.rejected.clear();
  state.sent.length = 0;
  state.toasts.length = 0;
  const storage = new Map<string, string>();
  if (legacy !== undefined) storage.set(LEGACY_KEY, JSON.stringify(legacy));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  vi.resetModules();
  const { useSidebarFoldersStore } = await import("./sidebarFoldersStore");
  const connect = (...ids: EnvironmentId[]) => {
    for (const id of ids) state.configs.set(id, { settings: { sidebarFolders: [] } });
    state.allowed = new Set(ids);
    state.notify(state.configs);
  };
  return { store: useSidebarFoldersStore, storage, connect };
}

const legacyFolder = (environmentIds: readonly EnvironmentId[]) => ({
  folders: [{ id: "work", name: "Work", collapsed: false }],
  folderIdByThreadKey: Object.fromEntries(environmentIds.map((id) => [`${id}:${thread}`, "work"])),
});

describe("useSidebarFoldersStore", () => {
  it("imports local folders and creates new ones without a primary environment", async () => {
    const { store, storage, connect } = await setup(legacyFolder([first]));
    connect(first);
    await vi.waitFor(() => expect(storage.has(LEGACY_KEY)).toBe(false));
    expect(store.getState().folders.map((folder) => folder.name)).toEqual(["Work"]);

    expect(store.getState().createFolder(null)).not.toBeNull();
    expect(state.sent.at(-1)).toMatchObject({ environmentId: first, input: { action: "create" } });
  });

  it("lets later environments import when one rejects it, and does not retry it", async () => {
    const { store, connect } = await setup(legacyFolder([first, second]));
    state.rejected.add(first);
    connect(first, second);
    await vi.waitFor(() =>
      expect(store.getState().folderIdByThreadKey).toEqual({
        [`${second}:${thread}`]: "work:second",
      }),
    );
    await vi.waitFor(() => expect(state.sent.at(-1)?.input.action).toBe("move_threads"));

    const attempts = state.sent.filter(({ environmentId }) => environmentId === first).length;
    // A retry would send its first request synchronously.
    state.notify(new Map(state.configs));
    expect(state.sent.filter(({ environmentId }) => environmentId === first)).toHaveLength(
      attempts,
    );
    expect(state.toasts).toEqual([]);
  });

  it("explains a rejected action and rolls it back", async () => {
    const { store, connect } = await setup();
    connect(first);
    state.rejected.add(first);
    store.getState().createFolder(first);
    expect(store.getState().folders).toHaveLength(1);
    await vi.waitFor(() =>
      expect(state.toasts).toMatchObject([{ title: "Could not update folders" }]),
    );
    expect(store.getState().folders).toEqual([]);
  });

  it("refuses without permission instead of showing a folder that vanishes", async () => {
    const { store, connect } = await setup();
    connect(first);
    state.allowed.clear();
    expect(store.getState().createFolder(first)).toBeNull();
    expect(store.getState().folders).toEqual([]);
    expect(state.sent).toEqual([]);
    expect(state.toasts).toMatchObject([{ title: "Folders unavailable" }]);
  });
});
