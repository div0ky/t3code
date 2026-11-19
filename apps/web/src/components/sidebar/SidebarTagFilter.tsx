import type { EnvironmentId } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { TagIcon } from "lucide-react";

import { describeTagFilter, useSidebarTagsStore } from "../../sidebarTagsStore";
import { requestTagName } from "../TagNameDialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

/** Narrows the sidebar to tagged threads, and is where tags are created, renamed and deleted. */
export function SidebarTagFilter(props: {
  /** Where a tag created here starts; null picks the home environment. */
  environmentId: EnvironmentId | null;
  onFilterChange: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const tags = useSidebarTagsStore((store) => store.tags);
  const filter = useSidebarTagsStore((store) => store.filter);
  const filterMode = useSidebarTagsStore((store) => store.filterMode);
  const actions = () => useSidebarTagsStore.getState();
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={
              filter.length > 0
                ? gt("Showing threads {tagFilter}", {
                    tagFilter: describeTagFilter(filter, filterMode),
                  })
                : gt("Filter threads by tag")
            }
          />
        }
      >
        <span className="relative flex shrink-0">
          <TagIcon className="size-4" />
          {/* The button colors its own icon, so a dot is what marks a filter as on. */}
          {filter.length > 0 ? (
            <span
              aria-hidden
              className="pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary ring-2 ring-sidebar"
            />
          ) : null}
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="w-[min(16rem,var(--available-width))]">
        <MenuGroup>
          <MenuGroupLabel>
            {tags.length === 0
              ? gt("No tags yet")
              : filterMode === "none"
                ? gt("Hide threads tagged")
                : gt("Show threads tagged")}
          </MenuGroupLabel>
          {tags.map((name) => (
            <MenuCheckboxItem
              key={name}
              checked={filter.includes(name)}
              closeOnClick={false}
              onCheckedChange={() => {
                actions().toggleFilter(name);
                props.onFilterChange();
              }}
            >
              <span className="min-w-0 truncate">{name}</span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        {tags.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>
                <T context="tag filter mode">Match</T>
              </MenuGroupLabel>
              <MenuRadioGroup
                value={filterMode}
                onValueChange={(mode) => {
                  actions().setFilterMode(mode);
                  props.onFilterChange();
                }}
              >
                {(
                  [
                    ["any", msg("Any tag (OR)")],
                    ["all", msg("All tags (AND)")],
                    ["none", msg("None of them (NOT)")],
                  ] as const
                ).map(([mode, label]) => (
                  <MenuRadioItem key={mode} value={mode} closeOnClick={false}>
                    <span className="flex items-center justify-between gap-2">
                      {m(label)}
                      <MenuRadioItemIndicator />
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem
          disabled={filter.length === 0}
          onClick={() => {
            actions().clearFilter();
            props.onFilterChange();
          }}
        >
          <T>Show all threads</T>
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={() =>
            void requestTagName({ title: gt("New tag") }).then((name) => {
              if (name !== null) actions().createTag(name, props.environmentId);
            })
          }
        >
          <T>New tag…</T>
        </MenuItem>
        {tags.length > 0 ? (
          <>
            <MenuSub>
              <MenuSubTrigger>
                <T>Rename tag</T>
              </MenuSubTrigger>
              <MenuSubPopup>
                {tags.map((name) => (
                  <MenuItem
                    key={name}
                    onClick={() =>
                      void requestTagName({ title: gt("Rename tag"), name }).then((next) => {
                        if (next !== null) actions().renameTag(name, next);
                      })
                    }
                  >
                    <span className="min-w-0 truncate">{name}</span>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>
                <T>Delete tag</T>
              </MenuSubTrigger>
              <MenuSubPopup>
                {tags.map((name) => (
                  // Its threads stay where they are; only the tag goes.
                  <MenuItem
                    key={name}
                    variant="destructive"
                    onClick={() => actions().deleteTag(name)}
                  >
                    <span className="min-w-0 truncate">{name}</span>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
