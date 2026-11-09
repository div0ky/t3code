import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, FolderIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import type { SidebarFolder } from "../../sidebarFoldersStore";
import { useUiStateStore } from "../../uiStateStore";
import {
  resolveSidebarFolderDot,
  resolveThreadLastVisitedAt,
  sidebarFolderMarker,
} from "../Sidebar.logic";
import { SortableSidebarMarker } from "./SidebarListMarkers";

const DOT_CLASS_NAME = {
  urgent: "bg-error",
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarCustomFolderRowId(folderId: string) {
  return `custom-folder:${folderId}`;
}

function FolderNameInput(props: {
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.name);
  return (
    <input
      autoFocus
      value={draft}
      aria-label="Folder name"
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => props.onCommit(draft)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Enter" && event.key !== "Escape") return;
        // Focus lands on the restored header button, which this key press would otherwise click.
        event.preventDefault();
        if (event.key === "Enter") props.onCommit(draft);
        else props.onCancel();
      }}
      className="h-6 min-w-0 flex-1 rounded-sm bg-transparent px-1 text-sm font-medium text-sidebar-foreground outline-none ring-1 ring-ring/70"
    />
  );
}

export const SidebarFolderHeader = memo(function SidebarFolderHeader(props: {
  folder: SidebarFolder;
  threadCount: number;
  hiddenThreads: readonly EnvironmentThreadShell[];
  isDropTarget: boolean;
  isRenaming: boolean;
  onToggle: (folderId: string) => void;
  onContextMenu: (folderId: string, position: { x: number; y: number }) => void;
  onCommitRename: (folderId: string, name: string) => void;
  onCancelRename: () => void;
}) {
  const { folder, hiddenThreads } = props;
  const rowId = sidebarCustomFolderRowId(folder.id);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = folder.collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  const label = (
    <>
      <FolderIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          props.isDropTarget ? "text-primary" : "text-sidebar-muted-foreground",
        )}
      />
      {props.isRenaming ? (
        <FolderNameInput
          key={folder.id}
          name={folder.name}
          onCommit={(name) => props.onCommitRename(folder.id, name)}
          onCancel={props.onCancelRename}
        />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            props.isDropTarget ? "text-primary" : "text-sidebar-foreground/90",
          )}
        >
          {folder.name}
        </span>
      )}
      {dot ? <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS_NAME[dot])} /> : null}
      <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
        {props.threadCount}
      </span>
      <ChevronDownIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
          folder.collapsed && "-rotate-90",
        )}
      />
    </>
  );
  const className = cn(
    "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left outline-none",
    props.isDropTarget && "bg-primary/10 ring-1 ring-inset ring-primary/40",
  );
  return (
    <SortableSidebarMarker
      marker={sidebarFolderMarker(folder.id)}
      data-testid="sidebar-custom-folder"
      className="relative mx-0.5 mt-1 h-8"
    >
      {/* An input cannot nest in a button, so a renaming header is a plain row. */}
      {props.isRenaming ? (
        <div className={className}>{label}</div>
      ) : (
        <button
          type="button"
          data-sidebar-row={rowId}
          aria-expanded={!folder.collapsed}
          onClick={() => props.onToggle(folder.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            props.onContextMenu(folder.id, { x: event.clientX, y: event.clientY });
          }}
          className={cn(
            className,
            "cursor-pointer hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          )}
        >
          {label}
        </button>
      )}
    </SortableSidebarMarker>
  );
});
