import type { EnvironmentId } from "@t3tools/contracts";
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
                ? `Showing threads ${describeTagFilter(filter, filterMode)}`
                : "Filter threads by tag"
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
              ? "No tags yet"
              : filterMode === "none"
                ? "Hide threads tagged"
                : "Show threads tagged"}
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
              <MenuGroupLabel>Match</MenuGroupLabel>
              <MenuRadioGroup
                value={filterMode}
                onValueChange={(mode) => {
                  actions().setFilterMode(mode);
                  props.onFilterChange();
                }}
              >
                {(
                  [
                    ["any", "Any tag (OR)"],
                    ["all", "All tags (AND)"],
                    ["none", "None of them (NOT)"],
                  ] as const
                ).map(([mode, label]) => (
                  <MenuRadioItem key={mode} value={mode} closeOnClick={false}>
                    <span className="flex items-center justify-between gap-2">
                      {label}
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
          Show all threads
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={() =>
            void requestTagName({ title: "New tag" }).then((name) => {
              if (name !== null) actions().createTag(name, props.environmentId);
            })
          }
        >
          New tag…
        </MenuItem>
        {tags.length > 0 ? (
          <>
            <MenuSub>
              <MenuSubTrigger>Rename tag</MenuSubTrigger>
              <MenuSubPopup>
                {tags.map((name) => (
                  <MenuItem
                    key={name}
                    onClick={() =>
                      void requestTagName({ title: "Rename tag", name }).then((next) => {
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
              <MenuSubTrigger>Delete tag</MenuSubTrigger>
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
