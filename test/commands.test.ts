import assert from "node:assert/strict";
import test from "node:test";
import { matchCatalog } from "../src/catalog.js";
import type { ScanResult } from "../src/scanner.js";

test("marks a matching catalog entry installed", () => {
  const scan: ScanResult = {
    packages: [
      {
        id: "package:npm:tools",
        type: "package",
        name: "tools",
        scope: "global",
        installedPath: "/tmp/agent/npm/tools",
        source: {
          kind: "npm",
          spec: "npm:tools@1.0.0",
          name: "tools",
          version: "1.0.0",
        },
      },
    ],
    skills: [],
    extensions: [],
  };

  const statuses = matchCatalog(
    {
      schemaVersion: 1,
      entries: [
        { name: "tools", type: "package", source: "npm:tools@1.0.0" },
      ],
    },
    scan,
  );

  assert.deepEqual(
    statuses.map((status) => [status.installed, status.entry.name]),
    [[true, "tools"]],
  );
});
