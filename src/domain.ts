import type { Source } from "./sources.js";

export type ResourceType = "package" | "skill" | "extension";
export type Scope = "global" | "local";

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
