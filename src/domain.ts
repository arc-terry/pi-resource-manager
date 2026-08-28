export type ResourceType = "package" | "skill" | "extension";
export type Scope = "global" | "local";
export const displayType = (type: ResourceType): "package" | "skill" | "plugin" =>
  type === "extension" ? "plugin" : type;
