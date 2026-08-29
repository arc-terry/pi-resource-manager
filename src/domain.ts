export type ResourceType = "package" | "skill" | "extension";
export type Scope = "global" | "local";

export interface NpmSource {
  kind: "npm";
  spec: string;
  name: string;
  version?: string;
}

export interface GitSource {
  kind: "git";
  spec: string;
  url: string;
  ref?: string;
}

export interface LocalPathSource {
  kind: "local-path";
  path: string;
}

export type Source = NpmSource | GitSource | LocalPathSource;

export interface Resource {
  id: string;
  type: ResourceType;
  name: string;
  scope: Scope;
  source: Source;
  installedPath: string;
  projectRoot?: string;
  ownerPackageId?: string;
}

export const displayType = (type: ResourceType): "package" | "skill" | "plugin" =>
  type === "extension" ? "plugin" : type;
