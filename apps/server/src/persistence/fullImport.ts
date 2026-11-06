// @effect-diagnostics nodeBuiltinImport:off - statfs and synchronous SQLite have no Effect equivalent.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { FullImportPhase, FullImportPlan } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { rebuildMessageSearch } from "../orchestration-v2/messageSearchIndex.ts";
import { BUILD_MIGRATION_HEAD, recordedMigrations } from "./databaseMigrationHead.ts";
import { runMigrations } from "./Migrations.ts";

const DATABASE = "statev2.sqlite";
const ATTACHMENTS = "attachments";
// Secrets and environment identity stay behind: they belong to the install that created them.
const SETTINGS_FILES = ["settings.json", "client-settings.json", "keybindings.json"];
const REPLACED_ENTRIES = [
  DATABASE,
  `${DATABASE}-wal`,
  `${DATABASE}-shm`,
  ATTACHMENTS,
  ...SETTINGS_FILES,
];
const GIB = 1024 ** 3;
const decodeJson = Schema.decodeEffect(fromLenientJson(Schema.Unknown));

export class FullImportError extends Schema.TaggedError<FullImportError>()("FullImportError", {
  message: Schema.String,
}) {}

const fail = (message: string) => new FullImportError({ message });

const formatGib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

const countRows = (db: NodeSqlite.DatabaseSync, table: string): number => {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()?.count ?? 0);
  } catch {
    return 0;
  }
};

const directoryBytes = (directory: string): number => {
  if (!NodeFS.existsSync(directory)) return 0;
  return NodeFS.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce(
      (total, entry) => total + NodeFS.statSync(NodePath.join(entry.parentPath, entry.name)).size,
      0,
    );
};

const realPathOrSelf = (target: string) => {
  try {
    return NodeFS.realpathSync(target);
  } catch {
    return target;
  }
};

const newerMigrationRefusal = (recorded: ReadonlyArray<{ readonly id: number }>) => {
  const newest = Math.max(0, ...recorded.map(({ id }) => id));
  return newest > BUILD_MIGRATION_HEAD
    ? `Your T3 Code database is on migration ${newest}, but this build only knows migrations through ${BUILD_MIGRATION_HEAD}. Merge upstream into your fork and rebuild, then import again. Nothing was changed.`
    : undefined;
};

/** Everything the confirmation shows, and every reason to refuse before touching anything. */
export const planFullImport = Effect.fn("fullImport.plan")(function* (input: {
  readonly sourceDir: string;
  readonly targetDir: string;
}) {
  const sourceDatabase = NodePath.join(input.sourceDir, DATABASE);
  if (!NodeFS.existsSync(sourceDatabase)) {
    return yield* fail(`No T3 Code database found at ${sourceDatabase}.`);
  }
  if (NodeFS.realpathSync(input.sourceDir) === realPathOrSelf(input.targetDir)) {
    return yield* fail("This app already uses that data directory.");
  }
  const recorded = recordedMigrations(sourceDatabase);
  if (recorded === null) return yield* fail(`Could not read ${sourceDatabase}.`);
  const refusal = newerMigrationRefusal(recorded);
  if (refusal !== undefined) return yield* fail(refusal);

  return yield* Effect.try({
    try: (): FullImportPlan => {
      const source = new NodeSqlite.DatabaseSync(sourceDatabase, { readOnly: true });
      let copyBytes: number;
      let projects: number;
      let threads: number;
      try {
        const pragma = (name: string) =>
          Number(Object.values(source.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);
        copyBytes = (pragma("page_count") - pragma("freelist_count")) * pragma("page_size");
        projects = countRows(source, "projection_projects");
        threads = countRows(source, "orchestration_v2_projection_threads");
      } finally {
        source.close();
      }
      NodeFS.mkdirSync(input.targetDir, { recursive: true });
      const targetDatabase = NodePath.join(input.targetDir, DATABASE);
      let replacedThreads = 0;
      if (NodeFS.existsSync(targetDatabase)) {
        const target = new NodeSqlite.DatabaseSync(targetDatabase, { readOnly: true });
        try {
          replacedThreads = countRows(target, "orchestration_v2_projection_threads");
        } finally {
          target.close();
        }
      }
      const attachmentBytes = directoryBytes(NodePath.join(input.sourceDir, ATTACHMENTS));
      const stats = NodeFS.statfsSync(input.targetDir);
      return {
        copyBytes,
        attachmentBytes,
        // Rebuilding the search index and migrating both need room beyond the copy itself.
        requiredBytes: Math.ceil(copyBytes * 1.25) + attachmentBytes + GIB,
        freeBytes: stats.bavail * stats.bsize,
        projects,
        threads,
        replacedThreads,
      };
    },
    catch: (cause) => fail(`Could not inspect the import: ${String(cause)}`),
  }).pipe(
    Effect.filterOrFail(
      (plan) => plan.freeBytes >= plan.requiredBytes,
      (plan) =>
        fail(
          `Not enough free disk space: the import needs ${formatGib(plan.requiredBytes)} and ${formatGib(plan.freeBytes)} is free. Nothing was changed.`,
        ),
    ),
  );
});

/**
 * Stops the copy doing anything by itself. Only the rows that start work change; history stays.
 * Runs on the migrated copy, so every table here exists whatever version the source was on.
 */
export const neutralizeImportedDatabase = Effect.fn("fullImport.neutralize")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const table of [
        "orchestration_v2_effect_outbox",
        "orchestration_v2_thread_launch_workflows",
        "orchestration_command_receipts",
        "provider_session_runtime",
        "auth_sessions",
        "auth_pairing_links",
        "peer_environment_links",
        "scheduled_task_webhook_deliveries",
        "scheduled_task_webhook_relay_deliveries",
        "scheduled_task_webhook_pending",
        "scheduled_task_webhook_replay_keys",
      ]) {
        yield* sql.unsafe(`DELETE FROM "${table}"`).unprepared;
      }
      // Kept, so they can be turned back on once Nightly stops running them.
      yield* sql`UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL`;
      // Startup recovery cancels running runs, but continues them while their session looks live.
      yield* sql`
        UPDATE orchestration_v2_projection_provider_sessions
        SET status = 'stopped', payload_json = json_set(payload_json, '$.status', 'stopped')
        WHERE status NOT IN ('stopped', 'error')`;
      // A prepared continuation starts whatever state its session is in.
      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET payload_json = json_remove(payload_json, '$.restartContinuationOfRunId')
        WHERE status = 'starting'
          AND json_extract(payload_json, '$.restartContinuationOfRunId') IS NOT NULL`;
      // Open cohorts wake the parent thread when a subagent finishes during recovery. A run whose
      // first delegate has not finished has no cohort yet, which recovery treats as open.
      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET payload_json = json_set(
          payload_json,
          '$.delegatedCompletion',
          json('{"disposition":"stopped","nextGeneration":1,"delivery":null}'))
        WHERE json_type(payload_json, '$.delegatedCompletion') IS NULL
          AND run_id IN (
            SELECT run_id FROM orchestration_v2_projection_subagents WHERE origin = 'app_owned')`;
      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET payload_json = json_set(
          payload_json,
          '$.delegatedCompletion.disposition', 'stopped',
          '$.delegatedCompletion.delivery', json('null'))
        WHERE json_extract(payload_json, '$.delegatedCompletion.disposition') = 'open'
           OR json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'`;
      // Auto-resume arms itself again from any failure that still has a reset time.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET payload_json = json_remove(payload_json, '$.failure.resetAt')
        WHERE type = 'error' AND json_extract(payload_json, '$.failure.resetAt') IS NOT NULL`;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(payload_json, '$.limitRecovery')
        WHERE json_extract(payload_json, '$.limitRecovery') IS NOT NULL`;
      // A watched pull request wakes its thread when it changes.
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.pullRequests', (
          SELECT json_group_array(json_remove(link.value, '$.watch'))
          FROM json_each(payload_json, '$.pullRequests') AS link))
        WHERE EXISTS (
          SELECT 1 FROM json_each(payload_json, '$.pullRequests') AS link
          WHERE json_extract(link.value, '$.watch') IS NOT NULL)`;
    }),
  );
});

/** All-or-nothing: on any failure the replaced entries go back where they were. */
export const swapIntoPlace = (input: {
  readonly stagingDir: string;
  readonly targetDir: string;
  readonly backupDir: string;
  readonly staged: ReadonlyArray<string>;
}) => {
  const target = (name: string) => NodePath.join(input.targetDir, name);
  const backup = (name: string) => NodePath.join(input.backupDir, name);
  const backedUp: string[] = [];
  const placed: string[] = [];
  NodeFS.mkdirSync(input.backupDir, { recursive: true, mode: 0o700 });
  try {
    for (const name of REPLACED_ENTRIES) {
      if (!NodeFS.existsSync(target(name))) continue;
      NodeFS.renameSync(target(name), backup(name));
      backedUp.push(name);
    }
    for (const name of input.staged) {
      NodeFS.renameSync(NodePath.join(input.stagingDir, name), target(name));
      placed.push(name);
    }
  } catch (cause) {
    for (const name of placed) NodeFS.rmSync(target(name), { recursive: true, force: true });
    for (const name of backedUp) NodeFS.renameSync(backup(name), target(name));
    NodeFS.rmSync(input.backupDir, { recursive: true, force: true });
    throw cause;
  }
};

// In WAL mode this is refused while any other connection has the file open, even an idle one.
const assertTargetNotInUse = (targetDir: string) => {
  const databasePath = NodePath.join(targetDir, DATABASE);
  if (!NodeFS.existsSync(databasePath)) return;
  const db = new NodeSqlite.DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
  } finally {
    db.close();
  }
};

/** Builds the whole import beside the live data and only then swaps it in, so a failure changes nothing. */
export const runFullImport = Effect.fn("fullImport.run")(function* (input: {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly backupName: string;
  readonly onPhase: (phase: FullImportPhase) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  yield* planFullImport(input);
  const stagingDir = fullImportStagingDir(input.targetDir);
  const stagedDatabase = NodePath.join(stagingDir, DATABASE);
  const attempt = <A>(message: string, run: () => A) =>
    Effect.try({ try: run, catch: (cause) => fail(`${message}: ${String(cause)}`) });
  const inUse = `This app's data is still in use, so it was left as it is. Quit every D5 Code window and server and try again`;

  yield* attempt(inUse, () => assertTargetNotInUse(input.targetDir));
  yield* attempt("Could not prepare the import", () => {
    NodeFS.rmSync(stagingDir, { recursive: true, force: true });
    NodeFS.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  });

  return yield* Effect.gen(function* () {
    yield* input.onPhase("database");
    yield* attempt("Could not copy the database", () => {
      const source = new NodeSqlite.DatabaseSync(NodePath.join(input.sourceDir, DATABASE), {
        readOnly: true,
      });
      try {
        // A consistent snapshot: the source stays live and is never written to.
        source.prepare("VACUUM INTO ?").run(stagedDatabase);
      } finally {
        source.close();
      }
    });

    // The source is live: it may have upgraded since the plan was checked.
    const snapshotRefusal = newerMigrationRefusal(recordedMigrations(stagedDatabase) ?? []);
    if (snapshotRefusal !== undefined) return yield* fail(snapshotRefusal);

    yield* input.onPhase("preparing");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("PRAGMA foreign_keys = ON").unprepared;
      yield* runMigrations();
      yield* neutralizeImportedDatabase();
      // VACUUM can renumber the rowids the search index is keyed by.
      yield* rebuildMessageSearch(sql);
      // VACUUM INTO loses WAL mode; restore the server boot setting.
      yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: stagedDatabase })),
      Effect.mapError((cause) => fail(`Could not prepare the database: ${String(cause)}`)),
    );
    yield* attempt("Could not secure the database", () => NodeFS.chmodSync(stagedDatabase, 0o600));

    yield* input.onPhase("files");
    const staged = [DATABASE];
    // After the snapshot, so every attachment it mentions already exists.
    const sourceAttachments = NodePath.join(input.sourceDir, ATTACHMENTS);
    if (NodeFS.existsSync(sourceAttachments)) {
      yield* fs
        .copy(sourceAttachments, NodePath.join(stagingDir, ATTACHMENTS))
        .pipe(Effect.mapError((cause) => fail(`Could not copy attachments: ${String(cause)}`)));
      staged.push(ATTACHMENTS);
    }
    for (const name of SETTINGS_FILES) {
      const source = NodePath.join(input.sourceDir, name);
      if (!NodeFS.existsSync(source)) continue;
      const contents = yield* fs
        .readFileString(source)
        .pipe(Effect.mapError(() => fail(`Could not read ${source}.`)));
      yield* decodeJson(contents).pipe(Effect.mapError(() => fail(`${source} is not valid JSON.`)));
      yield* fs
        .writeFileString(NodePath.join(stagingDir, name), contents, { mode: 0o600 })
        .pipe(Effect.mapError(() => fail(`Could not stage ${name}.`)));
      staged.push(name);
    }

    yield* input.onPhase("finishing");
    const backupDir = NodePath.join(input.targetDir, "import-backups", input.backupName);
    // Checked again: a server may have started during the copy.
    yield* attempt(inUse, () => assertTargetNotInUse(input.targetDir));
    yield* attempt("Could not move the import into place, so nothing was changed", () =>
      swapIntoPlace({ stagingDir, targetDir: input.targetDir, backupDir, staged }),
    );
    return { backupDir };
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(stagingDir, { recursive: true, force: true })).pipe(
        Effect.ignore,
      ),
    ),
  );
});

/** The parent reads the growing database here to show progress, since VACUUM INTO reports none. */
export const fullImportStagingDir = (targetDir: string) =>
  NodePath.join(targetDir, "full-import-staging");
