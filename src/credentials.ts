import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { commandExists, runCommand } from "./util.js";
import { globalConfigDir, globalCredentialFile } from "./paths.js";

const SERVICE = "worldclasscitizen.ralph";

export type CredentialStore = "keychain" | "file";
export type CredentialSource = CredentialStore | "environment";

interface CredentialFile {
  schemaVersion: 1;
  credentials: Record<string, string>;
}

/** RALPH_CREDENTIAL_STORE=file skips the OS keychain entirely (headless or shared hosts). */
function fileStoreForced(): boolean {
  return process.env.RALPH_CREDENTIAL_STORE === "file";
}

/** OS keychain first, then the per-user file store, then the documented environment variable. */
export async function credentialSource(
  connectionId: string,
  envName?: string,
): Promise<CredentialSource | undefined> {
  if (await readKeychain(connectionId)) return "keychain";
  if ((await readFileStore()).credentials[connectionId]?.trim()) return "file";
  if (envName && process.env[envName]?.trim()) return "environment";
  return undefined;
}

async function readKeychain(connectionId: string): Promise<string | undefined> {
  if (fileStoreForced()) return undefined;
  if (process.platform === "darwin" && (await commandExists("security"))) {
    const result = await runCommand("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      connectionId,
      "-w",
    ]);
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  if (process.platform === "linux" && (await commandExists("secret-tool"))) {
    const result = await runCommand("secret-tool", [
      "lookup",
      "service",
      SERVICE,
      "connection",
      connectionId,
    ]);
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return undefined;
}

async function readFileStore(): Promise<CredentialFile> {
  try {
    const value = JSON.parse(
      await readFile(globalCredentialFile(), "utf8"),
    ) as CredentialFile;
    if (
      value?.schemaVersion === 1 &&
      value.credentials &&
      typeof value.credentials === "object"
    )
      return value;
  } catch {
    // First use, unreadable or corrupt store: the next write replaces it.
  }
  return { schemaVersion: 1, credentials: {} };
}

async function writeFileStore(store: CredentialFile): Promise<void> {
  await mkdir(globalConfigDir(), { recursive: true });
  const path = globalCredentialFile();
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows has no POSIX mode; the file stays inside the user's private profile.
  }
}

export async function getCredential(
  connectionId: string,
  envName?: string,
): Promise<string | undefined> {
  const keychain = await readKeychain(connectionId);
  if (keychain) return keychain;
  const stored = (await readFileStore()).credentials[connectionId];
  if (stored?.trim()) return stored.trim();
  return envName ? process.env[envName] : undefined;
}

export async function setCredential(
  connectionId: string,
  secret: string,
): Promise<CredentialStore> {
  if (!secret.trim()) throw new Error("빈 비밀값은 저장할 수 없습니다.");
  if (!fileStoreForced() && process.platform === "darwin" && (await commandExists("security"))) {
    const result = await runCommand("security", [
      "add-generic-password",
      "-U",
      "-s",
      SERVICE,
      "-a",
      connectionId,
      "-w",
      secret,
    ]);
    if (result.exitCode === 0) return "keychain";
  }
  if (!fileStoreForced() && process.platform === "linux" && (await commandExists("secret-tool"))) {
    const result = await runCommand(
      "secret-tool",
      [
        "store",
        "--label",
        `Ralph ${connectionId}`,
        "service",
        SERVICE,
        "connection",
        connectionId,
      ],
      { input: secret },
    );
    if (result.exitCode === 0) return "keychain";
  }
  const store = await readFileStore();
  store.credentials[connectionId] = secret.trim();
  await writeFileStore(store);
  return "file";
}

export async function removeCredential(connectionId: string): Promise<void> {
  if (!fileStoreForced() && process.platform === "darwin" && (await commandExists("security")))
    await runCommand("security", [
      "delete-generic-password",
      "-s",
      SERVICE,
      "-a",
      connectionId,
    ]);
  if (!fileStoreForced() && process.platform === "linux" && (await commandExists("secret-tool")))
    await runCommand("secret-tool", [
      "clear",
      "service",
      SERVICE,
      "connection",
      connectionId,
    ]);
  const store = await readFileStore();
  if (connectionId in store.credentials) {
    delete store.credentials[connectionId];
    await writeFileStore(store);
  }
}

/** Human-readable location of the stored secret, for status output only. */
export function describeStore(source: CredentialSource | undefined): string {
  if (source === "keychain") return "OS 키체인";
  if (source === "file") return globalCredentialFile();
  if (source === "environment") return "환경변수";
  return "미설정";
}
