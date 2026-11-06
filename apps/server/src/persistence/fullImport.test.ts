// @effect-diagnostics nodeBuiltinImport:off - fixtures set up real SQLite files beside the code under test.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { isOtherInstallWorktree } from "../worktreesDirectory.ts";
import { runFullImport, swapIntoPlace } from "./fullImport.ts";
import { runMigrations } from "./Migrations.ts";

const DB = "statev2.sqlite";

// Fills every NOT NULL column the row does not name, so fixtures survive new columns.
const insert = (
  db: NodeSqlite.DatabaseSync,
  table: string,
  row: Record<string, string | number>,
) => {
  const required = db
    .prepare(`SELECT name, type FROM pragma_table_info('${table}') WHERE "notnull" = 1`)
    .all()
    .map((column) => ({ name: String(column.name), type: String(column.type) }));
  const full: Record<string, string | number> = { ...row };
  for (const { name, type } of required) {
    if (full[name] === undefined) full[name] = type === "INTEGER" ? 0 : "x";
  }
  const names = Object.keys(full);
  db.prepare(
    `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
  ).run(...names.map((name) => full[name]!));
};

const createDatabase = (databasePath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const count = (db: NodeSqlite.DatabaseSync, table: string) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n);

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-full-import-" });
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "target");
  NodeFS.mkdirSync(sourceDir);
  NodeFS.mkdirSync(targetDir);
  yield* createDatabase(path.join(sourceDir, DB));
  yield* createDatabase(path.join(targetDir, DB));

  const source = new NodeSqlite.DatabaseSync(path.join(sourceDir, DB));
  const stale = "2020-01-01T00:00:00.000Z";
  insert(source, "projection_projects", {
    project_id: "p1",
    title: "Project",
    workspace_root: "/w",
  });
  const thread = {
    id: "t1",
    limitRecovery: { runId: "r1", resetAt: stale, autoResume: true },
    pullRequests: [{ url: "u", watch: { interval: 1 } }, { url: "v" }],
  };
  insert(source, "orchestration_v2_projection_threads", {
    thread_id: "t1",
    project_id: "p1",
    payload_json: JSON.stringify(thread),
  });
  for (const [id, text] of [
    ["m-deleted", "gone"],
    ["m1", "findable needle"],
  ] as const) {
    insert(source, "orchestration_v2_projection_messages", {
      message_id: id,
      thread_id: "t1",
      role: "user",
      streaming: 0,
      payload_json: JSON.stringify({ text }),
    });
  }
  // Leaves a rowid gap, which VACUUM closes, so a stale search index would point at the wrong row.
  source.exec(`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'm-deleted'`);
  const run = (id: string, ordinal: number, status: string, payload: object) =>
    insert(source, "orchestration_v2_projection_runs", {
      run_id: id,
      thread_id: "t1",
      ordinal,
      provider: "codex",
      status,
      requested_at: stale,
      payload_json: JSON.stringify(payload),
    });
  run("r-open", 1, "completed", {
    delegatedCompletion: {
      disposition: "open",
      nextGeneration: 1,
      delivery: { generation: 1, messageId: "m", taskIds: ["n"] },
    },
  });
  run("r-prepared", 2, "starting", { restartContinuationOfRunId: "r-open" });
  insert(source, "orchestration_v2_projection_provider_sessions", {
    provider_session_id: "s1",
    provider: "codex",
    status: "ready",
    updated_at: stale,
    payload_json: JSON.stringify({ id: "s1", status: "ready" }),
  });
  insert(source, "orchestration_v2_projection_turn_items", {
    turn_item_id: "i1",
    thread_id: "t1",
    type: "error",
    status: "failed",
    payload_json: JSON.stringify({ failure: { class: "usage_limit", resetAt: stale } }),
  });
  insert(source, "scheduled_tasks", {
    task_id: "task",
    enabled: 1,
    next_run_at: stale,
    project_id: "p1",
  });
  insert(source, "scheduled_task_webhook_pending", {
    delivery_id: "d",
    task_id: "task",
  });
  insert(source, "orchestration_v2_effect_outbox", { effect_id: "e", status: "pending" });
  insert(source, "provider_session_runtime", { thread_id: "t1" });
  insert(source, "auth_sessions", { session_id: "a" });
  insert(source, "auth_pairing_links", { id: "l" });
  insert(source, "peer_environment_links", { environment_id: "peer" });
  source.close();

  NodeFS.mkdirSync(path.join(sourceDir, "attachments"));
  NodeFS.writeFileSync(path.join(sourceDir, "attachments", "a.png"), "image");
  NodeFS.writeFileSync(path.join(sourceDir, "settings.json"), '{ // nightly\n "from": "source" }');
  NodeFS.writeFileSync(path.join(sourceDir, "environment-id"), "source-id");
  NodeFS.mkdirSync(path.join(sourceDir, "secrets"));
  NodeFS.writeFileSync(path.join(sourceDir, "secrets", "key.bin"), "source-secret");

  const target = new NodeSqlite.DatabaseSync(path.join(targetDir, DB));
  insert(target, "projection_projects", { project_id: "old", title: "Old", workspace_root: "/o" });
  target.close();
  NodeFS.mkdirSync(path.join(targetDir, "attachments"));
  NodeFS.writeFileSync(path.join(targetDir, "attachments", "old.png"), "old-image");
  NodeFS.writeFileSync(path.join(targetDir, "settings.json"), '{"from":"target"}');
  NodeFS.writeFileSync(path.join(targetDir, "environment-id"), "target-id");

  const targetStillOld = () => {
    const db = new NodeSqlite.DatabaseSync(path.join(targetDir, DB), { readOnly: true });
    const projects = db.prepare("SELECT project_id FROM projection_projects").all();
    db.close();
    assert.deepEqual(
      projects.map((row) => row.project_id),
      ["old"],
    );
    assert.equal(
      NodeFS.readFileSync(path.join(targetDir, "settings.json"), "utf8"),
      '{"from":"target"}',
    );
    assert.isTrue(NodeFS.existsSync(path.join(targetDir, "attachments", "old.png")));
    assert.isFalse(NodeFS.existsSync(path.join(targetDir, "full-import-staging")));
    assert.isFalse(NodeFS.existsSync(path.join(targetDir, "import-backups")));
  };
  const run_ = runFullImport({
    sourceDir,
    targetDir,
    backupName: "backup",
    onPhase: () => Effect.void,
  });
  return { sourceDir, targetDir, targetStillOld, runImport: run_ };
});

describe("runFullImport", () => {
  it.effect("copies history and leaves nothing that can start work on its own", () =>
    Effect.gen(function* () {
      const { sourceDir, targetDir, runImport } = yield* setup;
      const sourceBefore = NodeFS.readFileSync(NodePath.join(sourceDir, "settings.json"), "utf8");

      const { backupDir } = yield* runImport;

      const db = new NodeSqlite.DatabaseSync(NodePath.join(targetDir, DB), { readOnly: true });
      const payload = (table: string, key: string, id: string) =>
        JSON.parse(
          String(
            db.prepare(`SELECT payload_json FROM "${table}" WHERE ${key} = ?`).get(id)
              ?.payload_json,
          ),
        );
      assert.equal(count(db, "projection_projects"), 1);
      assert.equal(count(db, "orchestration_v2_projection_threads"), 1);
      for (const table of [
        "orchestration_v2_effect_outbox",
        "provider_session_runtime",
        "auth_sessions",
        "auth_pairing_links",
        "peer_environment_links",
        "scheduled_task_webhook_pending",
      ]) {
        assert.equal(count(db, table), 0, table);
      }
      const task = db.prepare("SELECT enabled, next_run_at FROM scheduled_tasks").get();
      assert.deepEqual({ ...task }, { enabled: 0, next_run_at: null });

      const session = db
        .prepare("SELECT status, payload_json FROM orchestration_v2_projection_provider_sessions")
        .get();
      assert.equal(session?.status, "stopped");
      assert.equal(JSON.parse(String(session?.payload_json)).status, "stopped");

      const runs = "orchestration_v2_projection_runs";
      assert.deepEqual(payload(runs, "run_id", "r-open").delegatedCompletion, {
        disposition: "stopped",
        nextGeneration: 1,
        delivery: null,
      });
      assert.isUndefined(payload(runs, "run_id", "r-prepared").restartContinuationOfRunId);

      const thread = payload("orchestration_v2_projection_threads", "thread_id", "t1");
      assert.isUndefined(thread.limitRecovery);
      assert.deepEqual(thread.pullRequests, [{ url: "u" }, { url: "v" }]);
      const failure = payload("orchestration_v2_projection_turn_items", "turn_item_id", "i1");
      assert.deepEqual(failure.failure, { class: "usage_limit" });

      const found = db
        .prepare(
          `SELECT m.message_id FROM orchestration_v2_message_search s
           JOIN orchestration_v2_projection_messages m ON m.rowid = s.rowid
           WHERE orchestration_v2_message_search MATCH 'needle'`,
        )
        .all();
      assert.deepEqual(
        found.map((row) => row.message_id),
        ["m1"],
      );
      assert.equal(Object.values(db.prepare("PRAGMA journal_mode").get() ?? {})[0], "wal");
      db.close();

      assert.equal(
        NodeFS.readFileSync(NodePath.join(targetDir, "attachments", "a.png"), "utf8"),
        "image",
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(targetDir, "settings.json"), "utf8"),
        sourceBefore,
      );
      // Identity and credentials belong to the install that made them.
      assert.equal(
        NodeFS.readFileSync(NodePath.join(targetDir, "environment-id"), "utf8"),
        "target-id",
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(targetDir, "secrets")));

      assert.equal(
        NodeFS.readFileSync(NodePath.join(backupDir, "settings.json"), "utf8"),
        '{"from":"target"}',
      );
      assert.isTrue(NodeFS.existsSync(NodePath.join(backupDir, "attachments", "old.png")));
      const backup = new NodeSqlite.DatabaseSync(NodePath.join(backupDir, DB), { readOnly: true });
      assert.equal(count(backup, "projection_projects"), 1);
      assert.equal(backup.prepare("SELECT title FROM projection_projects").get()?.title, "Old");
      backup.close();
      assert.isFalse(NodeFS.existsSync(NodePath.join(targetDir, "full-import-staging")));

      // The source is read, never neutralized.
      const source = new NodeSqlite.DatabaseSync(NodePath.join(sourceDir, DB), { readOnly: true });
      assert.equal(count(source, "orchestration_v2_effect_outbox"), 1);
      assert.equal(source.prepare("SELECT enabled FROM scheduled_tasks").get()?.enabled, 1);
      source.close();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a source from a newer build and changes nothing", () =>
    Effect.gen(function* () {
      const { sourceDir, targetStillOld, runImport } = yield* setup;
      const source = new NodeSqlite.DatabaseSync(NodePath.join(sourceDir, DB));
      source.exec(
        `INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99999, 'Future')`,
      );
      source.close();

      const error = yield* Effect.flip(runImport);

      assert.include(error.message, "migration 99999");
      assert.include(error.message, "Merge upstream");
      targetStillOld();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the current data when a step fails after the copy", () =>
    Effect.gen(function* () {
      const { sourceDir, targetStillOld, runImport } = yield* setup;
      NodeFS.writeFileSync(NodePath.join(sourceDir, "keybindings.json"), "{ not json");

      const error = yield* Effect.flip(runImport);

      assert.include(error.message, "keybindings.json");
      targetStillOld();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses while a server has the current database open", () =>
    Effect.gen(function* () {
      const { targetDir, targetStillOld, runImport } = yield* setup;
      const server = new NodeSqlite.DatabaseSync(NodePath.join(targetDir, DB));
      // An idle connection, like a server between requests.
      server.prepare("SELECT 1 FROM projection_projects").all();

      const error = yield* Effect.flip(runImport);

      assert.include(error.message, "still in use");
      server.close();
      targetStillOld();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("swapIntoPlace", () => {
  it.effect("puts everything back when a move fails halfway", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const stagingDir = NodePath.join(root, "staging");
      const targetDir = NodePath.join(root, "target");
      NodeFS.mkdirSync(stagingDir);
      NodeFS.mkdirSync(targetDir);
      NodeFS.writeFileSync(NodePath.join(stagingDir, DB), "new");
      NodeFS.writeFileSync(NodePath.join(targetDir, DB), "old");
      NodeFS.writeFileSync(NodePath.join(targetDir, `${DB}-wal`), "old-wal");

      assert.throws(() =>
        swapIntoPlace({
          stagingDir,
          targetDir,
          backupDir: NodePath.join(root, "backup"),
          staged: [DB, "settings.json"],
        }),
      );

      assert.equal(NodeFS.readFileSync(NodePath.join(targetDir, DB), "utf8"), "old");
      assert.equal(NodeFS.readFileSync(NodePath.join(targetDir, `${DB}-wal`), "utf8"), "old-wal");
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "backup")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("isOtherInstallWorktree", () => {
  it.effect("protects only the other install's worktrees", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const isOther = (worktree: string, own: string) =>
        isOtherInstallWorktree(worktree, own, path, "/home/me");
      assert.isTrue(isOther("/home/me/.t3/worktrees/repo/a", "/home/me/.t3-fork/worktrees"));
      assert.isFalse(isOther("/home/me/.t3-fork/worktrees/repo/a", "/home/me/.t3-fork/worktrees"));
      assert.isFalse(isOther("/home/me/.t3/worktrees/repo/a", "/home/me/.t3/worktrees"));
      assert.isFalse(isOther("/elsewhere/repo", "/home/me/.t3-fork/worktrees"));
      assert.isFalse(isOther("/home/me/.t3/worktrees-old/a", "/home/me/.t3-fork/worktrees"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
