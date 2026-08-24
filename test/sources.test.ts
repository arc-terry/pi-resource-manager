import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { parsePiSource, sourceIdentity } from "../src/sources.js";

test("parses pinned npm specs", () => {
  const source = parsePiSource("npm:@acme/pi-tools@1.2.3");

  assert.deepEqual(source, {
    kind: "npm",
    spec: "npm:@acme/pi-tools@1.2.3",
    name: "@acme/pi-tools",
    version: "1.2.3",
  });
  assert.equal(sourceIdentity(source), "npm:@acme/pi-tools");
});

test("retains unpinned npm specs", () => {
  const source = parsePiSource("npm:@acme/pi-tools");

  assert.deepEqual(source, {
    kind: "npm",
    spec: "npm:@acme/pi-tools",
    name: "@acme/pi-tools",
  });
});

test("normalizes git identity without its ref", () => {
  const source = parsePiSource("git:github.com/acme/pi-tools@v2");

  assert.deepEqual(source, {
    kind: "git",
    spec: "git:github.com/acme/pi-tools@v2",
    url: "github.com/acme/pi-tools",
    ref: "v2",
  });
  assert.equal(sourceIdentity(source), "git:github.com/acme/pi-tools");
});

test("rejects an arbitrary registry shorthand", () => {
  assert.throws(() => parsePiSource("acme/pi-tools"), /Pi-supported source/);
});

test("accepts a relative local path", () => {
  const source = parsePiSource("./my-package");

  assert.deepEqual(source, { kind: "local-path", path: resolve("./my-package") });
  assert.equal(sourceIdentity(source), `local:${resolve("./my-package")}`);
});

test("preserves SSH git sources", () => {
  const source = parsePiSource("git:git@github.com:acme/pi-tools@abc123");

  assert.deepEqual(source, {
    kind: "git",
    spec: "git:git@github.com:acme/pi-tools@abc123",
    url: "git@github.com:acme/pi-tools",
    ref: "abc123",
  });
  assert.equal(sourceIdentity(source), "git:git@github.com:acme/pi-tools");
});
