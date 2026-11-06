import type { FullImportMessage } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/cli";

const send = (message: FullImportMessage) => Console.log(JSON.stringify(message));

/** Runs outside the desktop main process, because copying a large database blocks for minutes. */
export const fullImportCommand = Command.make("__full-import", {
  sourceDir: Flag.String("source-dir"),
  targetDir: Flag.String("target-dir"),
  check: Flag.Boolean("check").pipe(Flag.withDefault(false)),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ sourceDir, targetDir, check }) =>
    Effect.gen(function* () {
      const { planFullImport, runFullImport } = yield* Effect.promise(
        () => import("../persistence/fullImport.ts"),
      );
      if (check) {
        const plan = yield* planFullImport({ sourceDir, targetDir });
        return yield* send({ type: "plan", plan });
      }
      const now = yield* DateTime.now;
      const { backupDir } = yield* runFullImport({
        sourceDir,
        targetDir,
        backupName: DateTime.formatIso(now).replaceAll(":", "-"),
        onPhase: (phase) => send({ type: "phase", phase }),
      });
      yield* send({ type: "done", backupDir });
    }).pipe(
      Effect.catchTags({
        FullImportError: (error) => send({ type: "refused", reason: error.message }),
      }),
    ),
  ),
);
