import { useState } from "react";

import {
  desktopSettingsImportStateAtom,
  getDesktopSettingsImportBridge,
} from "~/state/desktopSettingsImport";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function SettingsImportRow() {
  const bridge = getDesktopSettingsImportBridge();
  const query = useEnvironmentQuery(bridge ? desktopSettingsImportStateAtom : null);
  const [pending, setPending] = useState(false);

  if (!bridge || !query.data?.available) return null;
  const run = () => {
    setPending(true);
    void bridge
      .run()
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not import settings",
            description: error instanceof Error ? error.message : "Something went wrong.",
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return (
    <SettingsRow
      {...searchableSetting("settings-import")}
      description={`Copy provider, appearance, and keybinding settings from T3 Code or T3 Code Nightly (${query.data.sourcePath}). Threads and saved credentials are not copied.`}
      control={
        <Button size="sm" variant="outline" disabled={pending} onClick={run}>
          Import
        </Button>
      }
    />
  );
}
