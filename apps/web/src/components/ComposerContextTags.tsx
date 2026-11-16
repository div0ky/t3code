import { TagIcon } from "lucide-react";

import { useSidebarTagsStore } from "../sidebarTagsStore";
import { ComposerControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { openThreadTagPicker } from "./ThreadTagPicker";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Tags for a new chat, chosen before its first send. */
export function ComposerContextTags({ draftId }: { draftId: string }) {
  const tags = useSidebarTagsStore((store) => store.draftTags[draftId]);
  const label = tags === undefined || tags.length === 0 ? "Tags" : tags.join(", ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size="xs"
            className="min-w-0 shrink"
            aria-label={`Tags: ${tags === undefined || tags.length === 0 ? "none" : label}`}
            data-composer-context-control
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openThreadTagPicker({ draftId, position: { x: rect.left, y: rect.bottom + 4 } });
            }}
          />
        }
      >
        <TagIcon aria-hidden="true" className="size-3" />
        <ComposerContextLabel>{label}</ComposerContextLabel>
      </TooltipTrigger>
      <TooltipPopup>Tags for this chat</TooltipPopup>
    </Tooltip>
  );
}
