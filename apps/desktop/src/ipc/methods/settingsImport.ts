import {
  DesktopSettingsImportResultSchema,
  DesktopSettingsImportStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopSettingsImport from "../../app/DesktopSettingsImport.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getSettingsImportState = makeIpcMethod({
  channel: IpcChannels.SETTINGS_IMPORT_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopSettingsImportStateSchema,
  handler: Effect.fn("desktop.ipc.settingsImport.getState")(function* () {
    return yield* (yield* DesktopSettingsImport.DesktopSettingsImport).state;
  }),
});

export const runSettingsImport = makeIpcMethod({
  channel: IpcChannels.SETTINGS_IMPORT_RUN_CHANNEL,
  payload: Schema.Void,
  result: DesktopSettingsImportResultSchema,
  handler: Effect.fn("desktop.ipc.settingsImport.run")(function* () {
    const result = yield* (yield* DesktopSettingsImport.DesktopSettingsImport).confirmAndImport;
    if (result.imported) {
      const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
      yield* lifecycle.relaunch("settings-import").pipe(Effect.forkDetach);
    }
    return result;
  }),
});
