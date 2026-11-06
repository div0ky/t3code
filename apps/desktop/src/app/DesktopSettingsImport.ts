import type { DesktopSettingsImportResult, DesktopSettingsImportState } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { isForkDesktopVersion } from "./DesktopStatePaths.ts";

// Secrets and environment identity stay behind: they belong to the install that created them.
const SETTINGS_FILES = ["settings.json", "client-settings.json", "keybindings.json"] as const;
const OFFERED_MARKER = "settings-import-offered";
// The same lenient parser the settings readers use: these files may hold comments.
const decodeJson = Schema.decodeEffect(fromLenientJson(Schema.Unknown));

export class DesktopSettingsImportError extends Schema.TaggedError<DesktopSettingsImportError>()(
  "DesktopSettingsImportError",
  { message: Schema.String },
) {}

/** Validates every source file before writing any, so a bad file cannot leave a partial import. */
export const copySettingsFiles = Effect.fn("desktop.settingsImport.copySettingsFiles")(
  function* (input: {
    readonly sourceDir: string;
    readonly targetDir: string;
    readonly join: (first: string, ...segments: string[]) => string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const fail = (message: string) => new DesktopSettingsImportError({ message });
    const files: Array<{ readonly name: string; readonly contents: string }> = [];
    for (const name of SETTINGS_FILES) {
      const source = input.join(input.sourceDir, name);
      if (!(yield* fs.exists(source).pipe(Effect.orElseSucceed(() => false)))) continue;
      const contents = yield* fs
        .readFileString(source)
        .pipe(Effect.mapError(() => fail(`Could not read ${source}.`)));
      yield* decodeJson(contents).pipe(Effect.mapError(() => fail(`${source} is not valid JSON.`)));
      files.push({ name, contents });
    }
    if (files.length === 0) {
      return yield* fail(`No settings found in ${input.sourceDir}.`);
    }
    yield* fs
      .makeDirectory(input.targetDir, { recursive: true })
      .pipe(Effect.mapError(() => fail(`Could not create ${input.targetDir}.`)));
    for (const { name, contents } of files) {
      const target = input.join(input.targetDir, name);
      const temporary = `${target}.import-tmp`;
      yield* Effect.gen(function* () {
        if (yield* fs.exists(target)) yield* fs.copyFile(target, `${target}.before-import`);
        yield* fs.writeFileString(temporary, contents, { mode: 0o600 });
        yield* fs.rename(temporary, target);
      }).pipe(Effect.mapError(() => fail(`Could not write ${target}.`)));
    }
  },
);

export class DesktopSettingsImport extends Context.Service<
  DesktopSettingsImport,
  {
    readonly state: Effect.Effect<DesktopSettingsImportState>;
    /** Asks first; a confirmed import needs an app restart to take effect. */
    readonly confirmAndImport: Effect.Effect<
      DesktopSettingsImportResult,
      DesktopSettingsImportError
    >;
    /** Runs before the backend starts, so an accepted import applies without a restart. */
    readonly offerOnFirstLaunch: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopSettingsImport") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const fs = yield* FileSystem.FileSystem;
  const path = environment.path;
  // Stable and Nightly share this directory, so one source covers both.
  const sourceDir = path.join(environment.homeDirectory, ".t3", "userdata");
  const markerPath = path.join(environment.stateDir, OFFERED_MARKER);

  const available = Effect.gen(function* () {
    if (!isForkDesktopVersion(environment.appVersion) || sourceDir === environment.stateDir) {
      return false;
    }
    for (const name of SETTINGS_FILES) {
      if (yield* fs.exists(path.join(sourceDir, name)).pipe(Effect.orElseSucceed(() => false))) {
        return true;
      }
    }
    return false;
  });

  const state = available.pipe(
    Effect.map((isAvailable) => ({ available: isAvailable, sourcePath: sourceDir })),
  );

  const copy = copySettingsFiles({
    sourceDir,
    targetDir: environment.stateDir,
    join: path.join,
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs));

  const ask = (options: {
    readonly message: string;
    readonly confirm: string;
    readonly detail: string;
  }) =>
    dialog
      .showMessageBox({
        type: "question",
        message: options.message,
        detail: options.detail,
        buttons: [options.confirm, "Not Now"],
        defaultId: 0,
        cancelId: 1,
      })
      .pipe(Effect.map(({ response }) => response === 0));

  const confirmAndImport = Effect.gen(function* () {
    const confirmed = yield* ask({
      message: "Replace your settings with the ones from T3 Code?",
      confirm: "Import and Restart",
      detail: `Copies provider, appearance, and keybinding settings from ${sourceDir}, then restarts. Your current settings are kept beside them as .before-import files. Threads and saved credentials are not copied.`,
    }).pipe(
      Effect.mapError(
        () => new DesktopSettingsImportError({ message: "Could not open the import dialog." }),
      ),
    );
    if (!confirmed) return { imported: false };
    yield* copy;
    return { imported: true };
  }).pipe(Effect.withSpan("desktop.settingsImport.confirmAndImport"));

  const offerOnFirstLaunch = Effect.gen(function* () {
    if (!(yield* available) || (yield* fs.exists(markerPath))) return;
    yield* fs.makeDirectory(environment.stateDir, { recursive: true });
    // Written first so a crash during import cannot nag on every launch.
    yield* fs.writeFileString(markerPath, "offered");
    const confirmed = yield* ask({
      message: "Import your settings from T3 Code?",
      confirm: "Import Settings",
      detail: `Copies provider, appearance, and keybinding settings from ${sourceDir}, which T3 Code and T3 Code Nightly share. Threads and saved credentials are not copied. You can do this later in Settings → About.`,
    });
    if (confirmed) yield* copy;
  }).pipe(
    Effect.catchTags({
      DesktopSettingsImportError: (error) =>
        dialog.showErrorBox("Could not import settings", error.message),
    }),
    Effect.catch((error) => Effect.logWarning("Could not offer the settings import", { error })),
    Effect.withSpan("desktop.settingsImport.offerOnFirstLaunch"),
  );

  return DesktopSettingsImport.of({ state, confirmAndImport, offerOnFirstLaunch });
});

export const layer = Layer.effect(DesktopSettingsImport, make);
