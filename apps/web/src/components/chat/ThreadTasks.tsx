import type { OrchestrationV2PlanStep } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDashedIcon, CircleEllipsisIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { windowTaskSteps } from "../ChatView.logic";

const MAX_VISIBLE_STEPS = 12;

const statusLabels = {
  pending: "Pending",
  running: "In progress",
  completed: "Done",
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
  return (
    <li className="ps-6.5 text-xs text-muted-foreground/70">
      {count} {label}
    </li>
  );
}

/** The agent's todo list, pinned at the end of the timeline while it is in play. */
export function ThreadTasks({
  steps,
  live,
  runningTaskCount,
}: {
  readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
  /** The run that wrote the list is still working. */
  readonly live: boolean;
  /** Background commands and subagents still running, shown under the current step. */
  readonly runningTaskCount: number;
}) {
  const { visible, hiddenBefore, hiddenAfter } = windowTaskSteps(steps, MAX_VISIBLE_STEPS);
  const done = steps.filter((step) => step.status === "completed").length;
  const current =
    steps.find((step) => step.status === "running") ??
    steps.find((step) => step.status === "pending");
  return (
    <div className="chat-content-lane px-1 pb-3">
      <ul
        aria-label={`Tasks: ${done} of ${steps.length} done`}
        data-thread-tasks="true"
        className="flex flex-col gap-2 rounded-2xl border border-border/80 bg-card/70 p-4 text-sm transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none"
      >
        <HiddenSteps
          count={hiddenBefore}
          label={hiddenBefore === 1 ? "earlier step" : "earlier steps"}
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
                <span className="sr-only">{statusLabels[step.status]}: </span>
                {step.text}
              </p>
              {step === current && runningTaskCount > 0 ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {runningTaskCount} running {runningTaskCount === 1 ? "task" : "tasks"}
                </p>
              ) : null}
            </div>
          </li>
        ))}
        <HiddenSteps count={hiddenAfter} label="more to go" />
      </ul>
    </div>
  );
}
