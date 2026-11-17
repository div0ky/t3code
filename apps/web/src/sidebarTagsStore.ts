import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type SidebarTag,
  type SidebarTagOperation,
  type ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

import { toastManager } from "./components/ui/toast";
import { randomUUID } from "./lib/utils";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { parseLegacySidebarFolders, planLegacySidebarFolderImport } from "./sidebarFolderImport";
import { createSidebarTagMirror } from "./sidebarTagMirror";
import { readPrimaryEnvironmentId } from "./state/environments";
import { environmentServerConfigsAtom, serverEnvironment } from "./state/server";

const LEGACY_STORAGE_KEY = "t3code:sidebar-folders:v1";
const FILTER_STORAGE_KEY = "t3code:sidebar-tag-filter:v1";
const FILTER_MODE_STORAGE_KEY = "t3code:sidebar-tag-filter-mode:v1";

/** Whether a thread needs any one of the filter's tags, all of them, or none of them. */
export type TagFilterMode = "any" | "all" | "none";

export function matchesTagFilter(
  threadTags: readonly string[] | undefined,
  filter: readonly string[],
  mode: TagFilterMode,
): boolean {
  const tagged = (tag: string) => threadTags?.includes(tag) ?? false;
  if (mode === "none") return !filter.some(tagged);
  return mode === "all" ? filter.every(tagged) : filter.some(tagged);
}

/** The filter as a phrase: "tagged Active or Mobile", "tagged Active and Mobile", "without Active or Mobile". */
export const describeTagFilter = (filter: readonly string[], mode: TagFilterMode) =>
  `${mode === "none" ? "without" : "tagged"} ${filter.join(mode === "all" ? " and " : " or ")}`;

interface SidebarTagsStore {
  /** Tag names, one per name however many environments hold it. */
  readonly tags: readonly string[];
  /** A thread's tag names. An array keeps its identity until that thread's tags change. */
  readonly tagsByThreadKey: Readonly<Record<string, readonly string[]>>;
  /** The tags the sidebar is narrowed to, matched by `filterMode`. Empty shows every thread. */
  readonly filter: readonly string[];
  readonly filterMode: TagFilterMode;
  readonly setFilterMode: (mode: TagFilterMode) => void;
  readonly toggleFilter: (name: string) => void;
  readonly clearFilter: () => void;
  readonly setThreadsTag: (threadKeys: readonly string[], name: string, tagged: boolean) => void;
  /** Tags live per environment; a tag with no thread yet starts in the open thread's one. */
  readonly createTag: (name: string, environmentId: EnvironmentId | null) => void;
  readonly renameTag: (name: string, nextName: string) => void;
  readonly deleteTag: (name: string) => void;
  /** Tags chosen on a new chat, held by draft id until its first send creates the thread. */
  readonly draftTags: Readonly<Record<string, readonly string[]>>;
  readonly setDraftTag: (draftId: string, name: string, tagged: boolean) => void;
  readonly applyDraftTags: (draftId: string, threadKeys: readonly string[]) => void;
  readonly clearDraftTags: (draftId: string) => void;
  /** The thread key or draft id whose tag icon should pop once; cleared when the pop ends. */
  readonly pulse: { readonly target: string; readonly seq: number } | null;
  readonly pulseTag: (target: string) => void;
  readonly settlePulse: (seq: number) => void;
}

type ServerConfigs = ReadonlyMap<
  EnvironmentId,
  { readonly settings: { readonly sidebarTags: readonly SidebarTag[] } }
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

/** Names match without case, so "shipping" and "Shipping" are one tag in every environment. */
const tagKey = (name: string) => name.trim().toLocaleLowerCase();

const storedFilter = typeof window === "undefined" ? null : readJson(FILTER_STORAGE_KEY);
// Kept as chosen: a tag that is missing until its environment connects comes back with it.
let chosenFilterKeys: readonly string[] = Array.isArray(storedFilter)
  ? storedFilter.filter((key) => typeof key === "string")
  : [];
const storedFilterModeValue =
  typeof window === "undefined" ? null : readJson(FILTER_MODE_STORAGE_KEY);
const storedFilterMode: TagFilterMode =
  storedFilterModeValue === "all" || storedFilterModeValue === "none"
    ? storedFilterModeValue
    : "any";
const mirror = createSidebarTagMirror();

/** New chats' tags with `name` renamed, or dropped without `nextName`; untouched lists keep their identity. */
function retagDrafts(
  draftTags: SidebarTagsStore["draftTags"],
  name: string,
  nextName?: string,
): SidebarTagsStore["draftTags"] {
  const isNamed = (tag: string) => tagKey(tag) === tagKey(name);
  return Object.fromEntries(
    Object.entries(draftTags).map(([draftId, tags]) => {
      if (!tags.some(isNamed)) return [draftId, tags];
      const kept =
        nextName === undefined
          ? tags.filter((tag) => !isNamed(tag))
          : tags
              .filter((tag) => isNamed(tag) || tagKey(tag) !== tagKey(nextName))
              .map((tag) => (isNamed(tag) ? nextName : tag));
      return [draftId, kept];
    }),
  );
}

const sameNames = (a: readonly string[] | undefined, b: readonly string[]) =>
  a !== undefined && a.length === b.length && a.every((name, index) => name === b[index]);

function publish() {
  const nameByKey = new Map<string, string>();
  const keysByThreadKey = new Map<string, Set<string>>();
  for (const [environmentId, environmentTags] of mirror.tags()) {
    for (const { name, threadIds } of environmentTags) {
      const key = tagKey(name);
      if (!nameByKey.has(key)) nameByKey.set(key, name);
      for (const threadId of threadIds) {
        const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
        keysByThreadKey.set(threadKey, (keysByThreadKey.get(threadKey) ?? new Set()).add(key));
      }
    }
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  const previous = useSidebarTagsStore.getState();
  const tags = [...nameByKey.values()].toSorted(byName);
  const filter = chosenFilterKeys.flatMap((key) => nameByKey.get(key) ?? []).toSorted(byName);
  const tagsByThreadKey: Record<string, readonly string[]> = {};
  for (const [threadKey, keys] of keysByThreadKey) {
    const names = [...keys].map((key) => nameByKey.get(key)!).toSorted(byName);
    const kept = previous.tagsByThreadKey[threadKey];
    tagsByThreadKey[threadKey] = sameNames(kept, names) ? kept! : names;
  }
  useSidebarTagsStore.setState({
    tags: sameNames(previous.tags, tags) ? previous.tags : tags,
    filter: sameNames(previous.filter, filter) ? previous.filter : filter,
    tagsByThreadKey,
  });
}

function setChosenFilterKeys(keys: readonly string[]) {
  chosenFilterKeys = keys;
  writeLocal(FILTER_STORAGE_KEY, keys.length === 0 ? null : keys);
  publish();
}

function syncFromServer(configs: ServerConfigs) {
  let changed = mirror.retain(new Set(configs.keys()));
  for (const [environmentId, config] of configs) {
    if (mirror.receive(environmentId, config.settings.sidebarTags)) changed = true;
  }
  if (changed) publish();
}

type PendingEntry = ReturnType<typeof mirror.begin>;

async function send(
  environmentId: EnvironmentId,
  operation: SidebarTagOperation,
  entry: PendingEntry,
  reportFailure: boolean,
) {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSidebarTags,
    { environmentId, input: operation },
    { label: "update tags", reportFailure },
  );
  if (result._tag === "Success") {
    mirror.acknowledge(entry);
    return true;
  }
  mirror.discard(environmentId, entry);
  publish();
  if (reportFailure) {
    toastManager.add({
      type: "error",
      title: "Could not update tags",
      description: "This server may need an update. Your change was not saved.",
    });
  }
  return false;
}

const canUpdateTags = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(serverEnvironment.updateSidebarTags.permissionAtom(environmentId));

// One environment's sends, in the order they were made.
const sending = new Map<EnvironmentId, Promise<unknown>>();

/**
 * Shows every operation at once, then sends them one at a time behind the environment's earlier
 * ones: a tagging that overtakes its tag's create is dropped by the server.
 */
function dispatch(
  environmentId: EnvironmentId,
  operations: readonly SidebarTagOperation[],
  reportFailure: boolean,
) {
  const entries = operations.map((operation) => mirror.begin(environmentId, operation));
  publish();
  const run = async () => {
    for (const [index, operation] of operations.entries()) {
      if (await send(environmentId, operation, entries[index]!, reportFailure)) continue;
      for (const entry of entries.slice(index + 1)) mirror.discard(environmentId, entry);
      publish();
      return false;
    }
    return true;
  };
  const sent = sending.get(environmentId)?.then(run) ?? run();
  sending.set(environmentId, sent);
  void sent.finally(() => {
    if (sending.get(environmentId) === sent) sending.delete(environmentId);
  });
  return sent;
}

function dispatchUserActions(
  environmentId: EnvironmentId,
  operations: readonly SidebarTagOperation[],
) {
  if (operations.length === 0) return;
  if (canUpdateTags(environmentId)) {
    void dispatch(environmentId, operations, true);
    return;
  }
  toastManager.add({
    type: "error",
    title: "Tags unavailable",
    description: "This connection cannot change tags in this environment.",
  });
}

const tagsNamed = (environmentTags: readonly SidebarTag[], name: string) =>
  environmentTags.filter((tag) => tagKey(tag.name) === tagKey(name));

// The hosted app has no primary environment, so the first connected one holds threadless tags.
const homeEnvironmentId = (configs: ServerConfigs) =>
  readPrimaryEnvironmentId() ?? configs.keys().next().value ?? null;

let importingLegacyFolders = false;
// Config pushes retrigger the import, so a server that rejected it waits for the next launch.
const rejectedImportEnvironmentIds = new Set<EnvironmentId>();
const permissionWatchedEnvironmentIds = new Set<EnvironmentId>();

async function importLegacyFolders(configs: ServerConfigs) {
  if (parseLegacySidebarFolders(readJson(LEGACY_STORAGE_KEY)) === null) return;
  // A session, and so the permission, loads after the first config, and no push has to follow it.
  for (const environmentId of configs.keys()) {
    if (permissionWatchedEnvironmentIds.has(environmentId)) continue;
    permissionWatchedEnvironmentIds.add(environmentId);
    appAtomRegistry.subscribe(
      serverEnvironment.updateSidebarTags.permissionAtom(environmentId),
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
        !canUpdateTags(environmentId)
      ) {
        continue;
      }
      const plan = planLegacySidebarFolderImport(legacy, environmentId, home);
      if (!(await dispatch(environmentId, plan.operations, false))) {
        rejectedImportEnvironmentIds.add(environmentId);
        continue;
      }
      writeLocal(LEGACY_STORAGE_KEY, plan.remaining);
    }
  } finally {
    importingLegacyFolders = false;
  }
}

export const useSidebarTagsStore = create<SidebarTagsStore>((set, get) => ({
  tags: [],
  tagsByThreadKey: {},
  filter: [],
  toggleFilter: (name) => {
    const key = tagKey(name);
    setChosenFilterKeys(
      chosenFilterKeys.includes(key)
        ? chosenFilterKeys.filter((candidate) => candidate !== key)
        : [...chosenFilterKeys, key],
    );
  },
  clearFilter: () => setChosenFilterKeys([]),
  filterMode: storedFilterMode,
  setFilterMode: (filterMode) => {
    writeLocal(FILTER_MODE_STORAGE_KEY, filterMode === "any" ? null : filterMode);
    set({ filterMode });
  },
  setThreadsTag: (threadKeys, name, tagged) => {
    if (name.trim().length === 0) return;
    const threadIdsByEnvironment = new Map<EnvironmentId, ThreadId[]>();
    for (const threadKey of threadKeys) {
      const ref = parseScopedThreadKey(threadKey);
      if (ref === null) continue;
      threadIdsByEnvironment.set(ref.environmentId, [
        ...(threadIdsByEnvironment.get(ref.environmentId) ?? []),
        ref.threadId,
      ]);
    }
    const tagsByEnvironment = new Map(mirror.tags());
    for (const [environmentId, threadIds] of threadIdsByEnvironment) {
      const named = tagsNamed(tagsByEnvironment.get(environmentId) ?? [], name);
      if (!tagged) {
        dispatchUserActions(
          environmentId,
          named
            .filter((tag) => tag.threadIds.some((threadId) => threadIds.includes(threadId)))
            .map((tag) => ({ action: "untag_threads", tagId: tag.id, threadIds })),
        );
        continue;
      }
      const existing = named[0];
      const tagId = existing?.id ?? randomUUID();
      dispatchUserActions(environmentId, [
        ...(existing === undefined
          ? [{ action: "create" as const, tagId, name: name.trim() }]
          : []),
        { action: "tag_threads", tagId, threadIds },
      ]);
    }
  },
  createTag: (name, environmentId) => {
    const target =
      environmentId ?? homeEnvironmentId(appAtomRegistry.get(environmentServerConfigsAtom));
    if (target === null || name.trim().length === 0) return;
    if (get().tags.some((existing) => tagKey(existing) === tagKey(name))) return;
    dispatchUserActions(target, [{ action: "create", tagId: randomUUID(), name: name.trim() }]);
  },
  renameTag: (name, nextName) => {
    const next = nextName.trim();
    if (next.length === 0 || next === name) return;
    for (const [environmentId, environmentTags] of mirror.tags()) {
      const named = tagsNamed(environmentTags, name);
      if (named.length === 0) continue;
      dispatchUserActions(
        environmentId,
        named.map((tag) => ({ action: "rename", tagId: tag.id, name: next })),
      );
    }
    set((state) => ({ draftTags: retagDrafts(state.draftTags, name, next) }));
    if (chosenFilterKeys.includes(tagKey(name))) {
      setChosenFilterKeys([
        ...new Set(chosenFilterKeys.map((key) => (key === tagKey(name) ? tagKey(next) : key))),
      ]);
    }
  },
  deleteTag: (name) => {
    for (const [environmentId, environmentTags] of mirror.tags()) {
      const named = tagsNamed(environmentTags, name);
      if (named.length === 0) continue;
      dispatchUserActions(
        environmentId,
        named.map((tag) => ({ action: "delete", tagId: tag.id })),
      );
    }
    set((state) => ({ draftTags: retagDrafts(state.draftTags, name) }));
    setChosenFilterKeys(chosenFilterKeys.filter((key) => key !== tagKey(name)));
  },
  // ponytail: in memory, so a reload drops a draft's tags; persist with the draft if that grates.
  draftTags: {},
  setDraftTag: (draftId, name, tagged) => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const rest = (get().draftTags[draftId] ?? []).filter(
      (existing) => tagKey(existing) !== tagKey(trimmed),
    );
    set((state) => ({
      draftTags: { ...state.draftTags, [draftId]: tagged ? [...rest, trimmed] : rest },
    }));
  },
  applyDraftTags: (draftId, threadKeys) => {
    for (const name of get().draftTags[draftId] ?? []) get().setThreadsTag(threadKeys, name, true);
  },
  clearDraftTags: (draftId) =>
    set(({ draftTags: { [draftId]: _dropped, ...draftTags } }) => ({ draftTags })),
  pulse: null,
  pulseTag: (target) => set((state) => ({ pulse: { target, seq: (state.pulse?.seq ?? 0) + 1 } })),
  // Settling only its own pulse keeps a row that remounts later from replaying an old one.
  settlePulse: (seq) => set((state) => (state.pulse?.seq === seq ? { pulse: null } : state)),
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
