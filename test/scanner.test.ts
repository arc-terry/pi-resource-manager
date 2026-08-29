import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { locationsFor, updateSettingsArray, writeFileAtomic } from "../src/settings.js";
import { scanPi } from "../src/scanner.js";
import { makeTempDir } from "./helpers.js";

test("scans package settings plus global skills and extensions", async () => {
  const root = await makeTempDir(); const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "skills", "review"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n");
  await writeFile(join(agentDir, "extensions", "team.ts"), "export default () => {};");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@acme/pi-tools@1.2.3"] }));
  const scan = await scanPi({ agentDir });
  assert.equal(scan.packages[0]?.source.spec, "npm:@acme/pi-tools@1.2.3");
  assert.equal(scan.skills[0]?.name, "review");
  assert.equal(scan.extensions[0]?.name, "team");
});

test("uses documented global and local Pi locations", async () => {
  const root = await makeTempDir();
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");

  assert.deepEqual(locationsFor("global", agentDir), {
    agentDir,
    settingsPath: join(agentDir, "settings.json"),
    packageDirs: [join(agentDir, "npm"), join(agentDir, "git")],
    skillsDirs: [join(agentDir, "skills"), join(homedir(), ".agents", "skills")],
    extensionsDir: join(agentDir, "extensions"),
  });
  assert.throws(() => locationsFor("local", agentDir), /projectRoot/);
  assert.deepEqual(locationsFor("local", agentDir, projectRoot), {
    agentDir,
    settingsPath: join(projectRoot, ".pi", "settings.json"),
    packageDirs: [join(projectRoot, ".pi", "npm"), join(projectRoot, ".pi", "git")],
    skillsDirs: [join(projectRoot, ".pi", "skills"), join(projectRoot, ".agents", "skills")],
    extensionsDir: join(projectRoot, ".pi", "extensions"),
  });
});

test("discovers direct Markdown skills as distinct resources", async () => {
  const root = await makeTempDir(); const agentDir = join(root, "agent");
  const skillsDir = join(agentDir, "skills");
  await mkdir(skillsDir, { recursive: true });
  const alpha = join(skillsDir, "alpha.md");
  const beta = join(skillsDir, "beta.md");
  await writeFile(alpha, "---\nname: alpha\ndescription: Alpha skill\n---\n");
  await writeFile(beta, "---\nname: beta\ndescription: Beta skill\n---\n");

  const scan = await scanPi({ agentDir });

  assert.deepEqual(scan.skills.map((resource) => resource.name), ["alpha", "beta"]);
  assert.deepEqual(scan.skills.map((resource) => resource.installedPath), [await realpath(alpha), await realpath(beta)]);
});

test("updates a settings array without dropping unrelated settings", async () => {
  const root = await makeTempDir();
  const path = join(root, "settings.json");
  await writeFile(path, JSON.stringify({ packages: ["npm:acme"], skills: ["old"], theme: "dark" }));

  await updateSettingsArray(path, "skills", "new");

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    packages: ["npm:acme"], skills: ["old", "new"], theme: "dark",
  });
});

test("cleans up the temporary file when an atomic rename fails", async () => {
  const root = await makeTempDir();
  const destination = join(root, "destination");
  await mkdir(destination);
  const temporary = `${destination}.tmp-${process.pid}`;

  await assert.rejects(writeFileAtomic(destination, "new contents"));
  await assert.rejects(access(temporary));
});

test("scans local package settings and extension directory indexes", async () => {
  const root = await makeTempDir();
  const projectRoot = join(root, "project");
  await mkdir(join(projectRoot, ".pi", "extensions", "project-tools"), { recursive: true });
  await writeFile(join(projectRoot, ".pi", "extensions", "project-tools", "index.ts"), "export default () => {};");
  await writeFile(join(projectRoot, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:project-tools@1"] }));

  const scan = await scanPi({ agentDir: join(root, "agent"), projectRoot });

  assert.equal(scan.packages.find((resource) => resource.source.spec === "npm:project-tools@1")?.scope, "local");
  assert.equal(scan.extensions.find((resource) => resource.name === "project-tools")?.scope, "local");
});

test("discovers configured extensions and package-provided resources with provenance", async () => {
  const root = await makeTempDir(); const agentDir = join(root, "agent");
  const packageRoot = join(agentDir, "npm", "@acme", "pi-tools");
  const configuredExtension = join(root, "configured.ts");
  await mkdir(join(packageRoot, "skills", "package-review"), { recursive: true });
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ pi: { skills: ["skills/package-review"], extensions: ["extensions/package-tools.ts"] } }));
  await writeFile(join(packageRoot, "skills", "package-review", "SKILL.md"), "---\nname: package-review\ndescription: Review packages\n---\n");
  await writeFile(join(packageRoot, "extensions", "package-tools.ts"), "export default () => {};");
  await writeFile(configuredExtension, "export default () => {};");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    packages: ["npm:@acme/pi-tools@1.2.3"], extensions: [configuredExtension],
  }));

  const scan = await scanPi({ agentDir });
  const packageResource = scan.packages.find((resource) => resource.source.spec === "npm:@acme/pi-tools@1.2.3");

  assert.ok(packageResource);
  assert.equal(scan.extensions.find((resource) => resource.name === "configured")?.source.kind, "local-path");
  assert.equal(scan.skills.find((resource) => resource.name === "package-review")?.ownerPackageId, packageResource.id);
  assert.equal(scan.extensions.find((resource) => resource.name === "package-tools")?.ownerPackageId, packageResource.id);
});

test("deduplicates a configured extension already found in its documented directory", async () => {
  const root = await makeTempDir(); const agentDir = join(root, "agent");
  const extensionPath = join(agentDir, "extensions", "team.ts");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(extensionPath, "export default () => {};");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extensionPath] }));

  const scan = await scanPi({ agentDir });
  const canonicalExtensionPath = await realpath(extensionPath);

  assert.equal(scan.extensions.filter((resource) => resource.installedPath === canonicalExtensionPath).length, 1);
});

test("prefers a local package and its derived resources over the global package", async () => {
  const root = await makeTempDir(); const agentDir = join(root, "agent"); const projectRoot = join(root, "project");
  const globalPackage = join(agentDir, "npm", "shared-tools");
  const localPackage = join(projectRoot, ".pi", "npm", "shared-tools");
  await mkdir(join(globalPackage, "skills", "global-skill"), { recursive: true });
  await mkdir(join(localPackage, "skills", "local-skill"), { recursive: true });
  await writeFile(join(globalPackage, "skills", "global-skill", "SKILL.md"), "---\nname: global-skill\ndescription: Global\n---\n");
  await writeFile(join(localPackage, "skills", "local-skill", "SKILL.md"), "---\nname: local-skill\ndescription: Local\n---\n");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:shared-tools"] }));
  await writeFile(join(projectRoot, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:shared-tools"] }));

  const scan = await scanPi({ agentDir, projectRoot });

  assert.deepEqual(scan.packages.filter((resource) => resource.name === "shared-tools").map((resource) => resource.scope), ["local"]);
  assert.equal(scan.skills.find((resource) => resource.name === "global-skill"), undefined);
  assert.equal(scan.skills.find((resource) => resource.name === "local-skill")?.scope, "local");
});

test("scans bare npm, settings-relative local, and SSH git package sources", async () => {
  const root = await makeTempDir(); const agentDir = join(root, "agent"); const projectRoot = join(root, "project");
  const localPackage = join(projectRoot, ".pi", "packages", "local-tools");
  await mkdir(localPackage, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["pi-skills", "git:git@github.com:user/repo"] }));
  await mkdir(join(projectRoot, ".pi"), { recursive: true });
  await writeFile(join(projectRoot, ".pi", "settings.json"), JSON.stringify({ packages: ["./packages/local-tools"] }));

  const scan = await scanPi({ agentDir, projectRoot });

  assert.equal(scan.packages.find((resource) => resource.source.spec === "pi-skills")?.source.kind, "npm");
  assert.equal(scan.packages.find((resource) => resource.source.kind === "local-path")?.installedPath, await realpath(localPackage));
  assert.equal(scan.packages.find((resource) => resource.source.spec === "git:git@github.com:user/repo")?.installedPath, join(agentDir, "git", "github.com", "user", "repo"));
});

test("applies package object glob, exclusion, force-include, and force-exclude filters", async () => {
  const root = await makeTempDir(); const agentDir = join(root, "agent");
  const packageRoot = join(agentDir, "npm", "object-tools");
  await mkdir(join(packageRoot, "skills", "wanted"), { recursive: true });
  await mkdir(join(packageRoot, "skills", "legacy"), { recursive: true });
  await mkdir(join(packageRoot, "skills", "removed"), { recursive: true });
  await mkdir(join(packageRoot, "manual-skill"), { recursive: true });
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ pi: { skills: ["skills"], extensions: ["extensions"] } }));
  await writeFile(join(packageRoot, "skills", "wanted", "SKILL.md"), "---\nname: wanted\ndescription: Wanted\n---\n");
  await writeFile(join(packageRoot, "skills", "legacy", "SKILL.md"), "---\nname: legacy\ndescription: Legacy\n---\n");
  await writeFile(join(packageRoot, "skills", "removed", "SKILL.md"), "---\nname: removed\ndescription: Removed\n---\n");
  await writeFile(join(packageRoot, "manual-skill", "SKILL.md"), "---\nname: manual-skill\ndescription: Manual\n---\n");
  await writeFile(join(packageRoot, "extensions", "current.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "legacy.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "removed.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "manual.ts"), "export default () => {};");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [{
    source: "npm:object-tools",
    skills: ["skills/*", "!skills/legacy", "+manual-skill", "-skills/removed"],
    extensions: ["extensions/*.ts", "!extensions/legacy.ts", "+manual.ts", "-extensions/removed.ts"],
  }] }));

  const scan = await scanPi({ agentDir });

  assert.deepEqual(scan.skills.filter((resource) => resource.ownerPackageId === "package:npm:object-tools").map((resource) => resource.name), ["wanted", "manual-skill"]);
  assert.deepEqual(scan.extensions.filter((resource) => resource.ownerPackageId === "package:npm:object-tools").map((resource) => resource.name), ["current", "manual"]);
});

test("maps URL-style SSH packages to Pi's git host directory", async () => {
  const root = await makeTempDir(); const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["ssh://git@github.com/user/repo"] }));

  const scan = await scanPi({ agentDir });

  assert.equal(scan.packages[0]?.installedPath, join(agentDir, "git", "github.com", "user", "repo"));
});

test("ignores root Markdown but discovers nested Markdown in .agents skills", async () => {
  const root = await makeTempDir(); const projectRoot = join(root, "project");
  const agentsSkills = join(projectRoot, ".agents", "skills");
  await mkdir(join(agentsSkills, "group"), { recursive: true });
  await writeFile(join(agentsSkills, "ignored.md"), "---\nname: ignored-root\ndescription: Ignored\n---\n");
  await writeFile(join(agentsSkills, "group", "nested.md"), "---\nname: nested-group\ndescription: Nested\n---\n");

  const scan = await scanPi({ agentDir: join(root, "agent"), projectRoot });

  assert.equal(scan.skills.find((resource) => resource.name === "ignored-root"), undefined);
  assert.equal(scan.skills.find((resource) => resource.name === "nested-group")?.scope, "local");
});

test("expands home-relative configured extension paths", async () => {
  const root = await makeTempDir(); const agentDir = join(root, "agent");
  const homeFixture = await mkdtemp(join(homedir(), "pi-collection-"));
  const extensionPath = join(homeFixture, "configured.ts");
  await mkdir(agentDir, { recursive: true });
  await writeFile(extensionPath, "export default () => {};");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [`~/${basename(homeFixture)}/configured.ts`] }));

  try {
    const scan = await scanPi({ agentDir });
    assert.equal(scan.extensions.find((resource) => resource.name === "configured")?.installedPath, await realpath(extensionPath));
  } finally {
    await rm(homeFixture, { recursive: true, force: true });
  }
});
