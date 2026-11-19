import { useGT } from "gt-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { useSidebarTagsStore } from "../sidebarTagsStore";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Popover, PopoverPopup } from "./ui/popover";

type Request = {
  readonly position: { readonly x: number; readonly y: number };
} & (
  | { readonly threadKeys: readonly string[] }
  // A new chat has no thread yet, so its tags wait on the draft.
  | { readonly draftId: string }
);
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Opens the tag picker for these threads, or a new chat's draft, at a point on screen. */
export function openThreadTagPicker(request: Request) {
  useRequest.setState({ request });
}

const close = () => useRequest.setState({ request: null });
const sameTag = (a: string, b: string) =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

export function ThreadTagPickerHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops a pending picker request when the host unmounts
  useEffect(() => close, []);
  return request ? (
    <ThreadTagPicker key={`${request.position.x}:${request.position.y}`} request={request} />
  ) : null;
}

/** Stays open while tags are toggled, so several go on in one visit. */
function ThreadTagPicker({ request }: { request: Request }) {
  const gt = useGT();
  const { position } = request;
  const draftId = "draftId" in request ? request.draftId : null;
  const threadKeys = "threadKeys" in request ? request.threadKeys : [];
  const targetCount = draftId === null ? threadKeys.length : 1;
  const storedTags = useSidebarTagsStore((store) => store.tags);
  const tagsByThreadKey = useSidebarTagsStore((store) => store.tagsByThreadKey);
  const draftTags = useSidebarTagsStore((store) =>
    draftId === null ? undefined : store.draftTags[draftId],
  );
  // A tag first named on a draft is not in the store until the chat is sent.
  const tags = [
    ...storedTags,
    ...(draftTags ?? []).filter((tag) => !storedTags.some((stored) => sameTag(stored, tag))),
  ];
  const [query, setQuery] = useState("");
  const [anchor] = useState(() => ({
    getBoundingClientRect: () => new DOMRect(position.x, position.y, 0, 0),
  }));
  const name = query.trim();
  const shown = tags.filter((tag) => tag.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
  const exact = tags.find((tag) => sameTag(tag, name));
  const taggedCount = (tag: string) =>
    draftId === null
      ? threadKeys.filter((key) => tagsByThreadKey[key]?.includes(tag)).length
      : draftTags?.some((draftTag) => sameTag(draftTag, tag))
        ? 1
        : 0;
  const setTag = (tag: string, tagged: boolean) =>
    draftId === null
      ? useSidebarTagsStore.getState().setThreadsTag(threadKeys, tag, tagged)
      : useSidebarTagsStore.getState().setDraftTag(draftId, tag, tagged);
  // A tag only some threads have goes onto the rest first; a second click takes it off them all.
  const toggle = (tag: string) => setTag(tag, taggedCount(tag) < targetCount);
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <PopoverPopup
        anchor={anchor}
        align="start"
        side="bottom"
        padding="compact"
        width="sm"
        aria-label={
          targetCount > 1 ? gt("Tags for {count} threads", { count: targetCount }) : gt("Tags")
        }
      >
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            value={query}
            maxLength={48}
            aria-label={gt("Find or create a tag")}
            placeholder={tags.length === 0 ? gt("Name a new tag") : gt("Find or create a tag")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || name.length === 0) {
                return;
              }
              event.preventDefault();
              const match = exact ?? (shown.length === 1 ? shown[0] : undefined);
              if (match === undefined) {
                setTag(name, true);
              } else {
                toggle(match);
              }
              setQuery("");
            }}
          />
          <ul className="flex max-h-64 flex-col overflow-y-auto">
            {shown.map((tag) => {
              const count = taggedCount(tag);
              return (
                <li key={tag}>
                  <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-accent sm:min-h-7">
                    <Checkbox
                      checked={count === targetCount}
                      indeterminate={count > 0 && count < targetCount}
                      onCheckedChange={() => toggle(tag)}
                    />
                    <span className="min-w-0 truncate">{tag}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {name.length > 0 && exact === undefined ? (
            <p className="px-2 text-secondary-label text-xs">
              {shown.length === 1
                ? gt("Enter toggles {tag}", { tag: shown[0] })
                : gt("Enter creates “{name}”", { name })}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
