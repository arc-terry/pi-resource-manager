import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { readProfile, writeProfileAtomic } from "../src/profile.js";
import * as profileModule from "../src/profile.js";
import type { ScanResult } from "../src/scanner.js";

test("converts a scan to schema-v1 entries without losing provenance", () => {
  const scan: ScanResult = {
    packages: [{
      id: "package:git:github.com/acme/tools",
      type: "package",
      name: "tools",
      scope: "global",
      installedPath: "/agent/git/tools",
      source: { kind: "git", spec: "git:github.com/acme/tools@abc123", url: "github.com/acme/tools", ref: "abc123" },
    }],
    skills: [],
    extensions: [{
      id: "extension:team",
      type: "extension",
      name: "team",
      scope: "local",
      projectRoot: "/project",
      installedPath: "/project/.pi/extensions/team.ts",
      ownerPackageId: "package:git:github.com/acme/tools",
      source: { kind: "local-path", path: "/agent/git/tools/extensions/team.ts" },
    }],
  };
  const profileFromScan = (profileModule as typeof profileModule & {
    profileFromScan?: (value: ScanResult, input: {
      name: string; agentDirectory: string; piVersion?: string; generatedAt?: Date;
    }) => unknown;
  }).profileFromScan;

  assert.equal(typeof profileFromScan, "function");
  assert.deepEqual(profileFromScan!(scan, {
    name: "workstation",
    agentDirectory: "/agent",
    piVersion: "0.52.0",
    generatedAt: new Date("2026-08-25T10:30:00.000Z"),
  }), {
    schemaVersion: 1,
    profile: {
      name: "workstation",
      generatedAt: "2026-08-25T10:30:00.000Z",
      pi: { agentDirectory: "/agent", version: "0.52.0" },
    },
    packages: [{
      id: "package:git:github.com/acme/tools",
      name: "tools",
      scope: "global",
      installedPath: "/agent/git/tools",
      source: { kind: "git", spec: "git:github.com/acme/tools@abc123", url: "github.com/acme/tools", ref: "abc123" },
    }],
    skills: [],
    extensions: [{
      id: "extension:team",
      name: "team",
      scope: "local",
      projectRoot: "/project",
      installedPath: "/project/.pi/extensions/team.ts",
      ownerPackageId: "package:git:github.com/acme/tools",
      source: { kind: "local-path", path: "/agent/git/tools/extensions/team.ts" },
    }],
  });
});

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
