export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Split a CLI argv into positionals and `--flag [value]` / `--flag=value` flags.
 * Shared by the toy CLI and the real-Reify CLI.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      const [key, inline] = token.slice(2).split("=");
      if (inline !== undefined) flags[key!] = inline;
      else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) flags[key!] = argv[++index]!;
      else flags[key!] = true;
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

export function boolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}
