import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { copySettingsFiles } from "./DesktopSettingsImport.ts";

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const sourceDir = yield* fs.makeTempDirectoryScoped();
  const targetDir = yield* fs.makeTempDirectoryScoped();
  const source = (name: string) => join(sourceDir, name);
  const target = (name: string) => join(targetDir, name);
  return { fs, sourceDir, targetDir, source, target, join };
});

describe("copySettingsFiles", () => {
  it.effect("copies settings only and keeps what it replaced", () =>
    Effect.gen(function* () {
      const { fs, sourceDir, targetDir, source, target, join } = yield* setup;
      yield* fs.writeFileString(source("settings.json"), '{"from":"nightly"}');
      yield* fs.writeFileString(source("environment-id"), "nightly-id");
      yield* fs.makeDirectory(source("secrets"));
      yield* fs.writeFileString(target("settings.json"), '{"from":"fork"}');

      yield* copySettingsFiles({ sourceDir, targetDir, join });

      assert.equal(yield* fs.readFileString(target("settings.json")), '{"from":"nightly"}');
      assert.equal(
        yield* fs.readFileString(target("settings.json.before-import")),
        '{"from":"fork"}',
      );
      assert.isFalse(yield* fs.exists(target("environment-id")));
      assert.isFalse(yield* fs.exists(target("secrets")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes nothing when any source file is invalid", () =>
    Effect.gen(function* () {
      const { fs, sourceDir, targetDir, source, target, join } = yield* setup;
      yield* fs.writeFileString(source("settings.json"), '{"from":"nightly"}');
      yield* fs.writeFileString(source("keybindings.json"), "{ not json");
      yield* fs.writeFileString(target("settings.json"), '{"from":"fork"}');

      const result = yield* copySettingsFiles({ sourceDir, targetDir, join }).pipe(Effect.flip);

      assert.include(result.message, "keybindings.json");
      assert.equal(yield* fs.readFileString(target("settings.json")), '{"from":"fork"}');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
