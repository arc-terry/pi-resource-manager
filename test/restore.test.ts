import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { planRestore } from "../src/restore.js";

test("plans global package install before remapped local extension settings", async () => {
  const source = join(await makeTempDir(), "x.ts");
  await writeFile(source, "export default () => {};");
  const profile = {
    schemaVersion: 1,
    profile: {
      name: "x",
      generatedAt: "2026-08-25T00:00:00.000Z",
      pi: { agentDirectory: "/tmp/a" },
    },
    packages: [{
      id: "package:npm:tools",
      name: "tools",
      scope: "global",
      installedPath: "/tmp/a/npm/tools",
      source: {
        kind: "npm",
        spec: "npm:tools@1.0.0",
        name: "tools",
        version: "1.0.0",
      },
    }],
    skills: [],
    extensions: [{
      id: "extension:x",
      name: "x",
      scope: "local",
      projectRoot: "/old",
      installedPath: "/old/.pi/extensions/x.ts",
      source: { kind: "local-path", path: source },
    }],
  };

  const actions = await planRestore(profile, { projectRoot: "/new" });

  assert.deepEqual(actions.map((action) => action.kind), ["pi-install", "settings-extension"]);
  assert.equal(actions[0]?.args.join(" "), "install npm:tools@1.0.0");
  assert.equal(actions[1]?.projectRoot, "/new");
});
