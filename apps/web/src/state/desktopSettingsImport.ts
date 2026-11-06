import type { DesktopBridge, DesktopSettingsImportState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

type DesktopSettingsImportBridge = DesktopBridge["settingsImport"];

class DesktopSettingsImportLoadError extends Schema.TaggedError<DesktopSettingsImportLoadError>()(
  "DesktopSettingsImportLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to check for settings to import.";
  }
}

export function getDesktopSettingsImportBridge(): DesktopSettingsImportBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.settingsImport;
}

export const desktopSettingsImportStateAtom = Atom.make(
  Effect.tryPromise({
    try: (): Promise<DesktopSettingsImportState> =>
      getDesktopSettingsImportBridge()?.getState() ??
      Promise.resolve({ available: false, sourcePath: "" }),
    catch: (cause) => new DesktopSettingsImportLoadError({ cause }),
  }),
).pipe(Atom.withLabel("desktop:settings-import:load"));
