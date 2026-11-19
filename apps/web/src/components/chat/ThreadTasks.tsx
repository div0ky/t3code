import type { OrchestrationV2PlanStep } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleEllipsisIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { windowTaskSteps } from "../ChatView.logic";

const MAX_VISIBLE_STEPS = 12;

const statusLabels = {
  pending: msg("Pending", { $context: "task step status" }),
  running: msg("In progress", { $context: "task step status" }),
  completed: msg("Done", { $context: "task step status" }),
} satisfies Record<OrchestrationV2PlanStep["status"], string>;

function StepIcon({
  status,
  live,
}: {
  readonly status: OrchestrationV2PlanStep["status"];
  readonly live: boolean;
}) {
  const className = "mt-0.5 size-4 shrink-0";
  if (status === "completed") {
    // Filling the ring and stroking in the card color leaves a solid disc with a cut-out check.
    return (
      <CircleCheckIcon
        aria-hidden
        className={cn(className, "fill-muted-foreground/55 stroke-card")}
      />
    );
  }
  if (status === "running") {
    return (
      <CircleEllipsisIcon
        aria-hidden
        className={cn(className, live ? "text-primary" : "text-muted-foreground/70")}
      />
    );
  }
  return <CircleDashedIcon aria-hidden className={cn(className, "text-muted-foreground/45")} />;
}

function HiddenSteps({ count, label }: { readonly count: number; readonly label: string }) {
  if (count === 0) return null;
  return <li className="ps-6.5 text-xs text-muted-foreground/70">{label}</li>;
}

/** The agent's todo list, pinned at the end of the timeline while it is in play. */
export function ThreadTasks({
  steps,
  live,
  runningTaskCount,
  collapsed,
  onToggleCollapsed,
}: {
  readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
  /** The run that wrote the list is still working. */
  readonly live: boolean;
  /** Work the agent left running after its turn, shown under the current step. */
  readonly runningTaskCount: number;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { visible, hiddenBefore, hiddenAfter } = windowTaskSteps(steps, MAX_VISIBLE_STEPS);
  const done = steps.filter((step) => step.status === "completed").length;
  const current =
    steps.find((step) => step.status === "running") ??
    steps.find((step) => step.status === "pending");
  return (
    <div className="chat-content-lane px-1 pb-3">
      <div
        data-thread-tasks="true"
        className="rounded-2xl border border-border/80 bg-card text-sm transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none"
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
          className="flex w-full cursor-pointer items-center gap-2 rounded-2xl px-4 py-2.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <span className="shrink-0 font-medium">
            {gt("Tasks {done}/{total}", { done, total: steps.length })}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {collapsed && current !== undefined ? current.text : null}
          </span>
          <span className="sr-only">{collapsed ? gt("Show tasks") : gt("Hide tasks")}</span>
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 transition-transform", collapsed && "-rotate-90")}
          />
        </button>
        {collapsed ? null : (
          <ul
            aria-label={gt("Tasks: {done} of {total} done", { done, total: steps.length })}
            className="flex flex-col gap-2 px-4 pb-4"
          >
            <HiddenSteps
              count={hiddenBefore}
              label={gt(
                "{count, plural, one {{count} earlier step} other {{count} earlier steps}}",
                { count: hiddenBefore },
              )}
            />
            {visible.map((step, index) => (
              // Providers do not promise unique step ids, and a list only ever grows or re-statuses.
              <li key={`${hiddenBefore + index}:${step.id}`} className="flex items-start gap-2.5">
                <StepIcon status={step.status} live={live} />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "wrap-anywhere",
                      step.status === "completed" ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    <span className="sr-only">{m(statusLabels[step.status])}: </span>
                    {step.text}
                  </p>
                  {step === current && runningTaskCount > 0 ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {gt(
                        "{count, plural, one {{count} running task} other {{count} running tasks}}",
                        { count: runningTaskCount },
                      )}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
            <HiddenSteps
              count={hiddenAfter}
              label={gt("{count} more to go", { count: hiddenAfter })}
            />
          </ul>
        )}
      </div>
    </div>
  );
}
