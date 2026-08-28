import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { profileFromScan, readProfile, writeProfileAtomic } from "../src/profile.js";

test("writes a schema-versioned YAML profile atomically", async () => {
  const file = join(await makeTempDir(), "profile.yml");
  const profile = {
    schemaVersion: 1,
    profile: {
      name: "test",
      generatedAt: "2026-08-25T00:00:00.000Z",
      pi: { agentDirectory: "/tmp/agent" },
    },
    packages: [],
    skills: [],
    extensions: [],
  };

  await writeProfileAtomic(file, profile);

  assert.match(await readFile(file, "utf8"), /schemaVersion: 1/);
  assert.deepEqual(await readProfile(file), profile);
});

test("rejects a profile with an unsupported schema version", async () => {
  const file = join(await makeTempDir(), "bad.yml");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(file, "schemaVersion: 2\n"));

  await assert.rejects(readProfile(file), /schemaVersion/);
});

test("profileFromScan preserves empty-string owner package provenance", () => {
  const profile = profileFromScan({
    packages: [],
    skills: [{
      id: "skill:package:example:/packages/example/skills/example",
      type: "skill",
      name: "example",
      scope: "global",
      source: { kind: "npm", spec: "example", name: "example" },
      installedPath: "/packages/example/skills/example",
      ownerPackageId: "",
    }],
    extensions: [],
  }, {
    name: "test",
    agentDirectory: "/tmp/agent",
    generatedAt: new Date("2026-08-25T00:00:00.000Z"),
  });

  assert.equal(profile.skills[0]?.ownerPackageId, "");
});

test("profileFromScan preserves pinned Git package refs", () => {
  const profile = profileFromScan({
    packages: [{
      id: "package:github.com/example/pi-package",
      type: "package",
      name: "pi-package",
      scope: "global",
      source: {
        kind: "git",
        spec: "git+https://github.com/example/pi-package.git#v1.2.3",
        url: "https://github.com/example/pi-package.git",
        ref: "v1.2.3",
      },
      installedPath: "/packages/github.com/example/pi-package",
    }],
    skills: [],
    extensions: [],
  }, {
    name: "test",
    agentDirectory: "/tmp/agent",
    generatedAt: new Date("2026-08-25T00:00:00.000Z"),
  });

  assert.deepEqual(profile.packages[0]?.source, {
    kind: "git",
    spec: "git+https://github.com/example/pi-package.git#v1.2.3",
    url: "https://github.com/example/pi-package.git",
    ref: "v1.2.3",
  });
});

test("profileFromScan retains project roots for local resources", () => {
  const profile = profileFromScan({
    packages: [],
    skills: [{
      id: "skill:/project/.pi/skills/example",
      type: "skill",
      name: "example",
      scope: "local",
      source: { kind: "local-path", path: "/project/.pi/skills/example" },
      installedPath: "/project/.pi/skills/example",
      projectRoot: "/project",
    }],
    extensions: [],
  }, {
    name: "test",
    agentDirectory: "/tmp/agent",
    generatedAt: new Date("2026-08-25T00:00:00.000Z"),
  });

  assert.equal(profile.skills[0]?.projectRoot, "/project");
});

test("profileFromScan writes canonical extension records to extensions", () => {
  const profile = profileFromScan({
    packages: [],
    skills: [],
    extensions: [{
      id: "extension:/agent/extensions/example.ts",
      type: "extension",
      name: "example",
      scope: "global",
      source: { kind: "local-path", path: "/agent/extensions/example.ts" },
      installedPath: "/agent/extensions/example.ts",
    }],
  }, {
    name: "test",
    agentDirectory: "/tmp/agent",
    generatedAt: new Date("2026-08-25T00:00:00.000Z"),
  });

  assert.equal(profile.extensions[0]?.id, "extension:/agent/extensions/example.ts");
  assert.equal(profile.skills.length, 0);
});
