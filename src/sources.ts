import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type Source =
  | { kind: "npm"; spec: string; name: string; version?: string }
  | { kind: "git"; spec: string; url: string; ref?: string }
  | { kind: "local-path"; path: string };

export class SourceParseError extends Error {
  constructor(input: string) {
    super(`Pi-supported source required: ${input}`);
    this.name = "SourceParseError";
  }
}

export function parsePiSource(input: string): Source {
  if (input.startsWith("npm:")) {
    return parseNpmSource(input);
  }

  if (input.startsWith("git:")) {
    return parseGitSource(input, input.slice("git:".length));
  }

  if (input.startsWith("https:") || input.startsWith("http:") || input.startsWith("ssh:")) {
    return parseGitSource(input, input);
  }

  if (isAbsolute(input) || input.startsWith("./") || input.startsWith("../")) {
    return { kind: "local-path", path: canonicalLocalPath(input) };
  }

  throw new SourceParseError(input);
}

export function sourceIdentity(source: Source): string {
  switch (source.kind) {
    case "npm":
      return `npm:${source.name}`;
    case "git":
      return `git:${source.url}`;
    case "local-path":
      return `local:${canonicalLocalPath(source.path)}`;
  }
}

function canonicalLocalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw error;
  }
}

function parseNpmSource(spec: string): Source {
  const nameAndVersion = spec.slice("npm:".length);
  const versionSeparator = nameAndVersion.lastIndexOf("@");
  const hasVersion = versionSeparator > 0;

  return hasVersion
    ? {
        kind: "npm",
        spec,
        name: nameAndVersion.slice(0, versionSeparator),
        version: nameAndVersion.slice(versionSeparator + 1),
      }
    : { kind: "npm", spec, name: nameAndVersion };
}

function parseGitSource(spec: string, urlAndRef: string): Source {
  const refSeparator = urlAndRef.lastIndexOf("@");
  const repositoryPathEnd = urlAndRef.lastIndexOf("/");
  const sshUserInfoSeparator = urlAndRef.indexOf("@");
  const isScpStyleSshSource = /^[^/@]+@[^/:]+:/.test(urlAndRef);
  const hasRef =
    refSeparator > repositoryPathEnd &&
    (!isScpStyleSshSource || refSeparator > sshUserInfoSeparator);

  return hasRef
    ? {
        kind: "git",
        spec,
        url: urlAndRef.slice(0, refSeparator),
        ref: urlAndRef.slice(refSeparator + 1),
      }
    : { kind: "git", spec, url: urlAndRef };
}
