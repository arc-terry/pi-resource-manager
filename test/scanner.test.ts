import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { scanPi } from "../src/scanner.js";
import * as settings from "../src/settings.js";

test("scans package settings plus global skills and extensions", async () => {
  const root = await makeTempDir();
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "skills", "review"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(
    join(agentDir, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\n",
  );
  await writeFile(join(agentDir, "extensions", "team.ts"), "export default () => {};");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:@acme/pi-tools@1.2.3"] }),
  );

  const scan = await scanPi({ agentDir });

  assert.equal(scan.packages[0]?.source.spec, "npm:@acme/pi-tools@1.2.3");
  assert.equal(scan.skills[0]?.name, "review");
  assert.equal(scan.extensions[0]?.name, "team");
});

test("scans configured skill paths and extension-directory indexes", async () => {
  const root = await makeTempDir();
  const agentDir = join(root, "agent");
  const custom = join(root, "custom");
  await mkdir(join(custom, "skill"), { recursive: true });
  await mkdir(join(custom, "plugin"), { recursive: true });
  await writeFile(join(custom, "skill", "SKILL.md"), "---\nname: configured\ndescription: Configured skill\n---\n");
  await writeFile(join(custom, "plugin", "index.ts"), "export default () => {};");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    skills: [join(custom, "skill")],
    extensions: [join(custom, "plugin")],
  }));

  const scan = await scanPi({ agentDir });

  assert.deepEqual(scan.skills.map((resource) => resource.name), ["configured"]);
  assert.deepEqual(scan.extensions.map((resource) => resource.name), ["index"]);
});

test("does not report an extension directory without an index module", async () => {
  const root = await makeTempDir();
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "extensions", "empty"), { recursive: true });

  const scan = await scanPi({ agentDir });

  assert.deepEqual(scan.extensions, []);
});

test("updates a configured extensions array without losing unrelated settings", async () => {
  const file = join(await makeTempDir(), "settings.json");
  await writeFile(file, JSON.stringify({ packages: ["npm:tools"], extensions: ["existing.ts"], theme: "night" }));
  const update = (settings as typeof settings & {
    updateSettingsArray?: (path: string, key: "skills" | "extensions", value: string) => Promise<void>;
  }).updateSettingsArray;

  assert.equal(typeof update, "function");
  await update!(file, "extensions", "added.ts");

  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    packages: ["npm:tools"],
    extensions: ["existing.ts", "added.ts"],
    theme: "night",
  });
});

test("scans local packages and resources supplied by those packages", async () => {
  const root = await makeTempDir();
  const projectRoot = join(root, "project");
  const agentDir = join(root, "agent");
  const packageRoot = join(projectRoot, ".pi", "npm", "tools");
  await mkdir(join(packageRoot, "skills", "review"), { recursive: true });
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ pi: { skills: ["skills/review"], extensions: ["extensions/team.ts"] } }),
  );
  await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n");
  await writeFile(join(packageRoot, "extensions", "team.ts"), "export default () => {};");
  await mkdir(join(projectRoot, ".pi"), { recursive: true });
  await writeFile(join(projectRoot, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:tools@1.0.0"] }));

  const scan = await scanPi({ agentDir, projectRoot });

  assert.deepEqual(scan.packages.map((resource) => [resource.name, resource.scope, resource.installedPath]), [
    ["tools", "local", await realpath(packageRoot)],
  ]);
  assert.deepEqual(scan.skills.map((resource) => [resource.name, resource.ownerPackageId]), [
    ["review", "package:npm:tools"],
  ]);
  assert.deepEqual(scan.extensions.map((resource) => [resource.name, resource.ownerPackageId]), [
    ["team", "package:npm:tools"],
  ]);
});
