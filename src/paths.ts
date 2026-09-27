import { homedir } from "node:os";
import { join } from "node:path";

/** Per-user Ralph directory. Project state never lives here; only host-wide files do. */
export function globalConfigDir(): string {
  if (process.env.RALPH_CONFIG_HOME) return process.env.RALPH_CONFIG_HOME;
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? homedir(), "ralph");
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "ralph");
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "ralph",
  );
}

/** Credential fallback store used when no OS keychain is available. Never committed. */
export function globalCredentialFile(): string {
  return join(globalConfigDir(), "credentials.json");
}
