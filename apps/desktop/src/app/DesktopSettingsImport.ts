import {
  type DesktopSettingsImportResult,
  type DesktopSettingsImportState,
  type FullImportMessage,
  FullImportMessageSchema,
  type FullImportPhase,
  type FullImportPlan,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Electron from "electron";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { isForkDesktopVersion } from "./DesktopStatePaths.ts";

// Secrets and environment identity stay behind: they belong to the install that created them.
const SETTINGS_FILES = ["settings.json", "client-settings.json", "keybindings.json"] as const;
const OFFERED_MARKER = "settings-import-offered";
const FULL_IMPORT_PENDING_MARKER = "full-import-pending";
const SOURCE_DATABASE = "statev2.sqlite";
const STAGED_DATABASE = ["full-import-staging", "statev2.sqlite"] as const;
const GIB = 1024 ** 3;
// The same lenient parser the settings readers use: these files may hold comments.
const decodeJson = Schema.decodeEffect(fromLenientJson(Schema.Unknown));

const decodeFullImportMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(FullImportMessageSchema),
);

const formatGib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

const PHASE_PROGRESS: Record<FullImportPhase, { readonly label: string; readonly at: number }> = {
  database: { label: "Copying your database", at: 0 },
  preparing: { label: "Preparing threads and search", at: 0.8 },
  files: { label: "Copying attachments and settings", at: 0.9 },
  finishing: { label: "Finishing up", at: 0.98 },
};

const PROGRESS_PAGE = `<!doctype html><meta charset="utf-8"><title>Importing</title>
<body style="margin:20px;font:13px system-ui;color-scheme:light dark">
<p id="label" style="margin:0 0 12px">Starting the import</p>
<progress id="bar" max="1" style="width:100%"></progress>
<p style="margin:12px 0 0;opacity:.7">D5 Code opens when this finishes. Your current data stays untouched until then.</p>
<script>function update(label, value) {
  document.getElementById("label").textContent = label;
  document.getElementById("bar").value = value;
}</script>`;

const progressUpdateScript = (label: string, value: number) =>
  `update(${JSON.stringify(label)}, ${value})`;

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
    /** Asks first; a confirmed full import runs after the restart, before the backend starts. */
    readonly confirmAndQueueFullImport: Effect.Effect<
      DesktopSettingsImportResult,
      DesktopSettingsImportError
    >;
    /** Runs a queued full import and the first-launch offer, while no server has the data open. */
    readonly beforeBackendStart: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopSettingsImport") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = environment.path;
  // Stable and Nightly share this directory, so one source covers both.
  const sourceDir = path.join(environment.homeDirectory, ".t3", "userdata");
  const markerPath = path.join(environment.stateDir, OFFERED_MARKER);
  const pendingFullImportPath = path.join(environment.stateDir, FULL_IMPORT_PENDING_MARKER);
  const stagedDatabasePath = path.join(environment.stateDir, ...STAGED_DATABASE);

  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  const canImport =
    isForkDesktopVersion(environment.appVersion) && sourceDir !== environment.stateDir;

  const available = Effect.gen(function* () {
    if (!canImport) return false;
    for (const name of SETTINGS_FILES) {
      if (yield* exists(path.join(sourceDir, name))) return true;
    }
    return false;
  });

  const fullImportAvailable = canImport
    ? exists(path.join(sourceDir, SOURCE_DATABASE))
    : Effect.succeed(false);

  const state = Effect.all({ available, fullImportAvailable }).pipe(
    Effect.map((states) => ({ ...states, sourcePath: sourceDir })),
  );

  const copy = copySettingsFiles({
    sourceDir,
    targetDir: environment.stateDir,
    join: path.join,
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs));

  const failFullImport = (message: string) => new DesktopSettingsImportError({ message });

  const runFullImportChild = (
    args: ReadonlyArray<string>,
    onMessage: (message: FullImportMessage) => Effect.Effect<void>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            yield* HostProcess.ExecutablePath,
            [
              environment.backendEntryPath,
              "__full-import",
              "--source-dir",
              sourceDir,
              "--target-dir",
              environment.stateDir,
              ...args,
            ],
            {
              cwd: environment.backendCwd,
              stdin: "ignore",
              env: { ELECTRON_RUN_AS_NODE: "1" },
              extendEnv: true,
            },
          ),
        );
        const [, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              // Anything else on stdout, such as a log line, is not part of the protocol.
              Stream.runForEach((line) =>
                Option.match(decodeFullImportMessage(line), {
                  onNone: () => Effect.void,
                  onSome: onMessage,
                }),
              ),
            ),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { exitCode: Number(exitCode), stderr };
      }),
    ).pipe(
      Effect.mapError((cause) => failFullImport(`Could not start the import: ${String(cause)}`)),
    );

  const planFullImport = Effect.gen(function* () {
    const result = yield* Ref.make<FullImportMessage | null>(null);
    const { stderr } = yield* runFullImportChild(["--check"], (message) =>
      Ref.set(result, message),
    );
    const message = yield* Ref.get(result);
    if (message?.type === "plan") return message.plan;
    if (message?.type === "refused") return yield* failFullImport(message.reason);
    yield* Effect.logWarning("The full import check stopped unexpectedly", { stderr });
    return yield* failFullImport("Could not inspect your T3 Code data.");
  });

  const fullImportDetail = (plan: FullImportPlan, restarts: boolean) =>
    [
      `Copies ${plan.projects} projects, ${plan.threads} threads and their history, ${formatGib(plan.attachmentBytes)} of attachments, and your settings from ${sourceDir}${restarts ? ", then restarts" : ""}.`,
      `This is a one-time copy, not a sync. Work you do afterwards in either app stays in that app.`,
      `It replaces this app's ${plan.replacedThreads} existing threads and its settings. They are kept in ${path.join(environment.stateDir, "import-backups")}.`,
      `The database copy is about ${formatGib(plan.copyBytes)}. The import needs ${formatGib(plan.requiredBytes)} free and you have ${formatGib(plan.freeBytes)}.`,
      `Copied threads keep using the same worktrees and the same Claude and Codex sessions as T3 Code, so avoid continuing one thread in both apps. Scheduled tasks arrive turned off. Saved credentials and linked environments are not copied.`,
    ].join("\n\n");

  const importWithProgress = Effect.scoped(
    Effect.gen(function* () {
      const window = yield* Effect.acquireRelease(
        // Auxiliary: the app must not reuse this hidden window as its main window afterwards.
        electronWindow
          .create(
            {
              width: 460,
              height: 170,
              title: "Importing from T3 Code",
              resizable: false,
              maximizable: false,
              fullscreenable: false,
              closable: false,
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
            },
            { auxiliary: true },
          )
          .pipe(
            Effect.tap((created) =>
              Effect.sync(
                () =>
                  void created.loadURL(
                    `data:text/html;charset=utf-8,${encodeURIComponent(PROGRESS_PAGE)}`,
                  ),
              ),
            ),
            Effect.mapError(() => failFullImport("Could not open the import window.")),
          ),
        (created) =>
          Effect.sync(() => {
            created.setProgressBar(-1);
            // Closing the only window would quit on Windows and Linux; the next window replaces it.
            created.hide();
            Electron.app.once("browser-window-created", () => created.destroy());
          }),
      );
      const show = (label: string, value: number) =>
        Effect.sync(() => {
          if (window.isDestroyed()) return;
          window.setProgressBar(value);
          void window.webContents
            .executeJavaScript(progressUpdateScript(label, value))
            .catch(() => undefined);
        });
      const plan = yield* planFullImport;
      const phase = yield* Ref.make<FullImportPhase | null>(null);
      const result = yield* Ref.make<FullImportMessage | null>(null);
      yield* Effect.gen(function* () {
        if ((yield* Ref.get(phase)) !== "database") return;
        const copied = yield* fs.stat(stagedDatabasePath).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );
        const done = plan.copyBytes === 0 ? 0 : Math.min(1, copied / plan.copyBytes);
        yield* show(
          `Copying your database: ${formatGib(copied)} of ${formatGib(plan.copyBytes)}`,
          done * PHASE_PROGRESS.preparing.at,
        );
      }).pipe(Effect.delay("500 millis"), Effect.forever, Effect.forkScoped);
      const { stderr } = yield* runFullImportChild([], (message) =>
        message.type === "phase"
          ? Ref.set(phase, message.phase).pipe(
              Effect.andThen(
                show(PHASE_PROGRESS[message.phase].label, PHASE_PROGRESS[message.phase].at),
              ),
            )
          : Ref.set(result, message),
      );
      const message = yield* Ref.get(result);
      if (message?.type === "refused") return yield* failFullImport(message.reason);
      if (message?.type !== "done") {
        yield* Effect.logWarning("The full import stopped unexpectedly", { stderr });
        return yield* failFullImport("The import stopped unexpectedly.");
      }
      yield* Effect.logInfo("Full import finished", { backupDir: message.backupDir });
    }),
  );

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

  const confirmFullImport = (plan: FullImportPlan, restarts: boolean) =>
    ask({
      message: "Replace this app's threads with a full import from T3 Code?",
      confirm: restarts ? "Import and Restart" : "Replace and Import",
      detail: fullImportDetail(plan, restarts),
    });

  const confirmAndQueueFullImport = Effect.gen(function* () {
    const plan = yield* planFullImport;
    const confirmed = yield* confirmFullImport(plan, true).pipe(
      Effect.mapError(() => failFullImport("Could not open the import dialog.")),
    );
    if (!confirmed) return { imported: false };
    yield* fs
      .writeFileString(pendingFullImportPath, "pending")
      .pipe(Effect.mapError(() => failFullImport(`Could not write ${pendingFullImportPath}.`)));
    return { imported: true };
  }).pipe(Effect.withSpan("desktop.settingsImport.confirmAndQueueFullImport"));

  const offerOnFirstLaunch = Effect.gen(function* () {
    const canOfferFull = yield* fullImportAvailable;
    if (!((yield* available) || canOfferFull) || (yield* fs.exists(markerPath))) return;
    yield* fs.makeDirectory(environment.stateDir, { recursive: true });
    // Written first so a crash during import cannot nag on every launch.
    yield* fs.writeFileString(markerPath, "offered");
    const { response } = yield* dialog.showMessageBox({
      type: "question",
      message: "Bring your work over from T3 Code?",
      detail: `Full Import copies your projects, threads, history, attachments, and settings. Import Settings copies only provider, appearance, and keybinding settings. Both read from ${sourceDir}, which T3 Code and T3 Code Nightly share. Saved credentials are not copied. You can do this later in Settings → About.`,
      buttons: ["Full Import…", "Import Settings", "Not Now"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 1) yield* copy;
    if (response !== 0) return;
    const plan = yield* planFullImport;
    if (yield* confirmFullImport(plan, false)) yield* importWithProgress;
  });

  const runQueuedFullImport = Effect.gen(function* () {
    // Removed first, so a crash during the import cannot repeat it on every launch.
    yield* fs.remove(pendingFullImportPath);
    yield* fs.writeFileString(markerPath, "offered");
    yield* importWithProgress;
  });

  const beforeBackendStart = Effect.gen(function* () {
    yield* (yield* exists(pendingFullImportPath)) ? runQueuedFullImport : offerOnFirstLaunch;
  }).pipe(
    Effect.catchTags({
      DesktopSettingsImportError: (error) =>
        dialog.showErrorBox(
          "Could not import from T3 Code",
          `${error.message}\n\nYour existing data in this app was kept.`,
        ),
    }),
    Effect.catch((error) => Effect.logWarning("Could not offer the import", { error })),
    Effect.withSpan("desktop.settingsImport.beforeBackendStart"),
  );

  return DesktopSettingsImport.of({
    state,
    confirmAndImport,
    confirmAndQueueFullImport,
    beforeBackendStart,
  });
});

export const layer = Layer.effect(DesktopSettingsImport, make);
