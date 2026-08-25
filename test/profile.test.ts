import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { readProfile, writeProfileAtomic } from "../src/profile.js";

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
