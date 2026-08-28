import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { GitSource, NpmSource, Source } from "./domain.js";

export class SourceParseError extends Error {}

export function parsePiSource(input: string): Source {
  if (input.startsWith("npm:")) {
    return parseNpmSource(input);
  }

  if (input.startsWith("git:") && !input.startsWith("git://")) {
    return parseGitSource(input, input.slice("git:".length));
  }

  if (/^(https:|http:|ssh:|git:)/.test(input)) {
    return parseGitSource(input, input);
  }

  if (isAbsolute(input) || input.startsWith("./") || input.startsWith("../")) {
    return { kind: "local-path", path: resolveLocalPath(input) };
  }

  throw new SourceParseError(`Pi-supported source required: ${input}`);
}

export function sourceIdentity(source: Source): string {
  switch (source.kind) {
    case "npm":
      return `npm:${source.name}`;
    case "git":
      return `git:${source.url}`;
    case "local-path":
      return `local:${resolveLocalPath(source.path)}`;
  }
}

function parseNpmSource(spec: string): NpmSource {
  const packageSpec = spec.slice("npm:".length);
  const versionSeparator = packageSpec.lastIndexOf("@");

  if (versionSeparator > 0) {
    return {
      kind: "npm",
      spec,
      name: packageSpec.slice(0, versionSeparator),
      version: packageSpec.slice(versionSeparator + 1),
    };
  }

  return { kind: "npm", spec, name: packageSpec };
}

function parseGitSource(spec: string, urlWithRef: string): GitSource {
  const refSeparator = gitRefSeparator(urlWithRef);

  if (refSeparator === -1) {
    return { kind: "git", spec, url: urlWithRef };
  }

  return {
    kind: "git",
    spec,
    url: urlWithRef.slice(0, refSeparator),
    ref: urlWithRef.slice(refSeparator + 1),
  };
}

function gitRefSeparator(url: string): number {
  const refSeparator = url.lastIndexOf("@");
  if (refSeparator === -1) return -1;

  const schemeEnd = url.indexOf("://");
  const repositoryStart = schemeEnd === -1
    ? Math.max(url.indexOf("/"), url.indexOf(":"))
    : url.indexOf("/", schemeEnd + 3);

  return refSeparator > repositoryStart ? refSeparator : -1;
}

function resolveLocalPath(path: string): string {
  const resolvedPath = resolve(path);
  return existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath;
}
