import { T, useGT } from "gt-react";

import { useSidebarTagsStore } from "../sidebarTagsStore";
import { ComposerControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { TagPulseIcon } from "./TagPulseIcon";
import { openThreadTagPicker } from "./ThreadTagPicker";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Tags for a new chat, chosen before its first send. */
export function ComposerContextTags({ draftId }: { draftId: string }) {
  const gt = useGT();
  const tags = useSidebarTagsStore((store) => store.draftTags[draftId]);
  const untagged = tags === undefined || tags.length === 0;
  const label = untagged ? gt("Tags") : tags.join(", ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size="xs"
            className="min-w-0 shrink"
            aria-label={untagged ? gt("Tags: none") : gt("Tags: {tags}", { tags: label })}
            data-composer-context-control
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openThreadTagPicker({ draftId, position: { x: rect.left, y: rect.bottom + 4 } });
            }}
          />
        }
      >
        <TagPulseIcon target={draftId} className="size-3" />
        <ComposerContextLabel>{label}</ComposerContextLabel>
      </TooltipTrigger>
      <TooltipPopup>
        <T>Tags for this chat</T>
      </TooltipPopup>
    </Tooltip>
  );
}
