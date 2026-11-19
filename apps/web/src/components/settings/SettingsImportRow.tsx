import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import {
  desktopSettingsImportStateAtom,
  getDesktopSettingsImportBridge,
} from "~/state/desktopSettingsImport";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function SettingsImportRow() {
  const bridge = getDesktopSettingsImportBridge();
  const query = useEnvironmentQuery(bridge ? desktopSettingsImportStateAtom : null);
  const [pending, setPending] = useState(false);
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();

  if (!bridge || !(query.data?.available || query.data?.fullImportAvailable)) return null;
  const run = (start: () => Promise<unknown>) => {
    setPending(true);
    void start()
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not import"),
            description: thrownErrorMessage(error, m) ?? gt("Something went wrong."),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return (
    <SettingsRow
      {...searchableSetting("settings-import")}
      description={gt(
        "Copy from T3 Code or Nightly. Import settings brings settings and keybindings. Full import also brings projects, threads, history, and attachments, replacing the threads here.",
      )}
      control={
        <div className="flex gap-2">
          {query.data.available ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(bridge.run)}>
              <T>Import settings</T>
            </Button>
          ) : null}
          {query.data.fullImportAvailable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(bridge.runFull)}
            >
              <T>Full import</T>
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
