import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const LEGACY_KEY = "t3code:sidebar-folders:v1";
const FILTER_KEY = "t3code:sidebar-tag-filter:v1";
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
  permissionListeners: new Map<string, () => void>(),
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
    subscribe: (atom: unknown, listener: (configs: unknown) => void) => {
      if (typeof atom === "string") state.permissionListeners.set(atom, () => listener(true));
      else state.notify = listener;
    },
  },
}));
vi.mock("./state/server", () => ({
  environmentServerConfigsAtom: { name: "configs" },
  serverEnvironment: { updateSidebarTags: { permissionAtom: (id: string) => id } },
}));
vi.mock("./state/environments", () => ({ readPrimaryEnvironmentId: () => null }));
vi.mock("./components/ui/toast", () => ({
  toastManager: { add: (toast: { title: string }) => state.toasts.push(toast) },
}));

async function setup(legacy?: unknown, filter?: readonly string[]) {
  state.configs.clear();
  state.allowed.clear();
  state.rejected.clear();
  state.sent.length = 0;
  state.toasts.length = 0;
  state.permissionListeners.clear();
  const storage = new Map<string, string>();
  if (legacy !== undefined) storage.set(LEGACY_KEY, JSON.stringify(legacy));
  if (filter !== undefined) storage.set(FILTER_KEY, JSON.stringify(filter));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  vi.resetModules();
  const { useSidebarTagsStore } = await import("./sidebarTagsStore");
  const connect = (...ids: EnvironmentId[]) => {
    for (const id of ids) state.configs.set(id, { settings: { sidebarTags: [] } });
    state.allowed = new Set(ids);
    state.notify(state.configs);
  };
  return { store: useSidebarTagsStore, storage, connect };
}

const legacyFolder = (environmentIds: readonly EnvironmentId[]) => ({
  folders: [{ id: "work", name: "Work", collapsed: false }],
  folderIdByThreadKey: Object.fromEntries(environmentIds.map((id) => [`${id}:${thread}`, "work"])),
});

describe("useSidebarTagsStore", () => {
  it("imports local folders as tags without a primary environment", async () => {
    const { store, storage, connect } = await setup(legacyFolder([first]));
    connect(first);
    await vi.waitFor(() => expect(storage.has(LEGACY_KEY)).toBe(false));
    expect(store.getState().tags).toEqual(["Work"]);
    expect(store.getState().tagsByThreadKey).toEqual({ [`${first}:${thread}`]: ["Work"] });

    store.getState().createTag("Later", null);
    expect(state.sent.at(-1)).toMatchObject({ environmentId: first, input: { action: "create" } });
  });

  it("imports once a session grants permission after the config, with no further push", async () => {
    const { store, storage } = await setup(legacyFolder([first]));
    state.configs.set(first, { settings: { sidebarTags: [] } });
    state.notify(state.configs);
    expect(state.sent).toEqual([]);

    state.allowed.add(first);
    state.permissionListeners.get(first)?.();
    await vi.waitFor(() => expect(storage.has(LEGACY_KEY)).toBe(false));
    expect(store.getState().tags).toEqual(["Work"]);
  });

  it("lets later environments import when one rejects it, and does not retry it", async () => {
    const { store, connect } = await setup(legacyFolder([first, second]));
    state.rejected.add(first);
    connect(first, second);
    await vi.waitFor(() =>
      expect(store.getState().tagsByThreadKey).toEqual({ [`${second}:${thread}`]: ["Work"] }),
    );
    await vi.waitFor(() => expect(state.sent.at(-1)?.input.action).toBe("tag_threads"));

    const attempts = state.sent.filter(({ environmentId }) => environmentId === first).length;
    // A retry would send its first request synchronously.
    state.notify(new Map(state.configs));
    expect(state.sent.filter(({ environmentId }) => environmentId === first)).toHaveLength(
      attempts,
    );
    expect(state.toasts).toEqual([]);
  });

  it("gives a thread several tags, reusing a name whatever its case and creating a new one", async () => {
    const { store, connect } = await setup();
    connect(first);
    const threadKey = `${first}:${thread}`;
    store.getState().setThreadsTag([threadKey], "Shipping", true);
    store.getState().setThreadsTag([threadKey], "later", true);
    expect(store.getState().tagsByThreadKey[threadKey]).toEqual(["later", "Shipping"]);
    await vi.waitFor(() => expect(state.sent).toHaveLength(4));

    store.getState().setThreadsTag([threadKey], "shipping", true);
    await vi.waitFor(() => expect(state.sent).toHaveLength(5));
    // The reused name sends no third create.
    expect(state.sent.filter(({ input }) => input.action === "create")).toHaveLength(2);
    expect(store.getState().tags).toEqual(["later", "Shipping"]);

    store.getState().setThreadsTag([threadKey], "Later", false);
    expect(store.getState().tagsByThreadKey[threadKey]).toEqual(["Shipping"]);
  });

  it("holds a new chat's tags on its draft and applies them to each thread it creates", async () => {
    const { store, connect } = await setup();
    connect(first);
    store.getState().setDraftTag("draft", "Shipping", true);
    store.getState().setDraftTag("draft", "later", true);
    store.getState().setDraftTag("draft", "shipping", true);
    store.getState().setDraftTag("draft", "LATER", false);
    expect(store.getState().draftTags.draft).toEqual(["shipping"]);
    // Nothing reaches the server until a thread exists.
    expect(state.sent).toEqual([]);

    // A multi-model send creates its threads one at a time; the second reuses the new tag.
    store.getState().applyDraftTags("draft", [`${first}:a`]);
    store.getState().applyDraftTags("draft", [`${first}:b`]);
    store.getState().clearDraftTags("draft");
    expect(store.getState().tagsByThreadKey).toEqual({
      [`${first}:a`]: ["shipping"],
      [`${first}:b`]: ["shipping"],
    });
    expect(store.getState().draftTags).toEqual({});
    await vi.waitFor(() => expect(state.sent).toHaveLength(3));
    expect(state.sent.filter(({ input }) => input.action === "create")).toHaveLength(1);
  });

  it("tags several threads with a new tag in one create and one tagging", async () => {
    const { store, connect } = await setup();
    connect(first, second);
    store.getState().setThreadsTag([`${first}:a`, `${first}:b`, `${second}:c`], "Shipping", true);
    await vi.waitFor(() => expect(state.sent).toHaveLength(4));
    expect(
      state.sent.filter(({ environmentId }) => environmentId === first).map(({ input }) => input),
    ).toMatchObject([{ action: "create" }, { action: "tag_threads", threadIds: ["a", "b"] }]);
  });

  it("keeps a thread's tag list identical while another thread's tags change", async () => {
    const { store, connect } = await setup();
    connect(first);
    store.getState().setThreadsTag([`${first}:a`], "Shipping", true);
    const before = store.getState().tagsByThreadKey[`${first}:a`];
    store.getState().setThreadsTag([`${first}:b`], "Later", true);
    expect(store.getState().tagsByThreadKey[`${first}:a`]).toBe(before);
  });

  it("drops a deleted tag from the filter and new chats, and follows a rename", async () => {
    const { store, storage, connect } = await setup();
    connect(first);
    store.getState().createTag("Shipping", first);
    store.getState().createTag("Later", first);
    store.getState().toggleFilter("Shipping");
    store.getState().toggleFilter("Later");
    expect(store.getState().filter).toEqual(["Later", "Shipping"]);
    store.getState().setDraftTag("draft", "shipping", true);
    store.getState().setDraftTag("draft", "Later", true);
    store.getState().setDraftTag("other", "Unrelated", true);
    const untouched = store.getState().draftTags.other;

    store.getState().renameTag("Shipping", "Shipped");
    expect(store.getState().filter).toEqual(["Later", "Shipped"]);
    expect(store.getState().draftTags.draft).toEqual(["Shipped", "Later"]);
    store.getState().deleteTag("Later");
    expect(store.getState().filter).toEqual(["Shipped"]);
    expect(store.getState().draftTags.draft).toEqual(["Shipped"]);
    expect(store.getState().draftTags.other).toBe(untouched);
    expect(JSON.parse(storage.get(FILTER_KEY)!)).toEqual(["shipped"]);
    store.getState().clearFilter();
    expect(storage.has(FILTER_KEY)).toBe(false);
  });

  it("ignores a filter naming a tag no environment has, and restores it when the tag returns", async () => {
    const { store, connect } = await setup(undefined, ["shipping"]);
    connect(first);
    expect(store.getState().filter).toEqual([]);
    store.getState().createTag("Shipping", first);
    expect(store.getState().filter).toEqual(["Shipping"]);
  });

  it("explains a rejected action and rolls it back", async () => {
    const { store, connect } = await setup();
    connect(first);
    state.rejected.add(first);
    store.getState().setThreadsTag([`${first}:${thread}`], "Work", true);
    expect(store.getState().tags).toEqual(["Work"]);
    await vi.waitFor(() =>
      expect(state.toasts).toMatchObject([{ title: "Could not update tags" }]),
    );
    expect(store.getState().tags).toEqual([]);
    expect(state.sent).toHaveLength(1);
  });

  it("refuses without permission instead of showing a tag that vanishes", async () => {
    const { store, connect } = await setup();
    connect(first);
    state.allowed.clear();
    store.getState().createTag("Work", first);
    expect(store.getState().tags).toEqual([]);
    expect(state.sent).toEqual([]);
    expect(state.toasts).toMatchObject([{ title: "Tags unavailable" }]);
  });
});
