import assert from "node:assert/strict";
import test from "node:test";
import { parsePiSource, sourceIdentity } from "../src/sources.js";

test("parses a pinned npm source into its canonical identity", () => {
  const source = parsePiSource("npm:@acme/pi-tools@1.2.3");

  assert.deepEqual(source, {
    kind: "npm",
    spec: "npm:@acme/pi-tools@1.2.3",
    name: "@acme/pi-tools",
    version: "1.2.3",
  });
  assert.equal(sourceIdentity(source), "npm:@acme/pi-tools");
});

test("normalizes git identity without its ref", () => {
  const source = parsePiSource("git:github.com/acme/pi-tools@v2");

  assert.equal(source.kind, "git");
  assert.equal(sourceIdentity(source), "git:github.com/acme/pi-tools");
});

test("rejects an arbitrary registry shorthand", () => {
  assert.throws(() => parsePiSource("acme/pi-tools"), /Pi-supported source/);
});

test("accepts a relative local path", () => {
  assert.equal(parsePiSource("./my-package").kind, "local-path");
});

test("preserves SSH git sources", () => {
  assert.equal(parsePiSource("git:git@github.com:acme/pi-tools@abc123").kind, "git");
});

test("parses git protocol URLs without stripping their protocol", () => {
  const source = parsePiSource("git://github.com/acme/pi-tools@v2");

  assert.deepEqual(source, {
    kind: "git",
    spec: "git://github.com/acme/pi-tools@v2",
    url: "git://github.com/acme/pi-tools",
    ref: "v2",
  });
  assert.equal(sourceIdentity(source), "git:git://github.com/acme/pi-tools");
});
