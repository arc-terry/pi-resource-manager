import { Command } from "commander";

export interface CommandDependencies {}

export function buildProgram(_deps: CommandDependencies): Command {
  return new Command()
    .name("pi-collection")
    .description("Manage Pi packages, skills, and plugins");
}
