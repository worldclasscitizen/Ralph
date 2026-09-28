import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { commandExists, runCommand } from "./util.js";
import { globalConfigDir, globalCredentialFile } from "./paths.js";

const SERVICE = "worldclasscitizen.ralph";
const DPAPI_PREFIX = "dpapi:";

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

/**
 * Windows has no keychain API reachable from Node without native modules, so the
 * file fallback is encrypted with DPAPI (current user) through PowerShell. Set
 * RALPH_CREDENTIAL_ENCRYPTION=none to store plaintext, or when PowerShell is
 * unavailable, in which case the store reports itself as unprotected.
 */
function encryptionMode(): "dpapi" | "none" {
  if (process.env.RALPH_CREDENTIAL_ENCRYPTION === "none") return "none";
  if (process.env.RALPH_CREDENTIAL_ENCRYPTION === "dpapi") return "dpapi";
  return process.platform === "win32" ? "dpapi" : "none";
}

async function windowsPowerShell(script: string, input: string): Promise<string | undefined> {
  for (const command of ["powershell.exe", "pwsh.exe"]) {
    if (!(await commandExists(command))) continue;
    const result = await runCommand(
      command,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { input, timeoutMs: 15_000 },
    );
    if (result.exitCode === 0) return result.stdout.trim();
  }
  return undefined;
}

async function protect(secret: string): Promise<string | undefined> {
  if (encryptionMode() !== "dpapi") return undefined;
  return await windowsPowerShell(
    "$s=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($s);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');[Convert]::ToBase64String($p)",
    secret,
  );
}

async function unprotect(blob: string): Promise<string | undefined> {
  const decoded = await windowsPowerShell(
    "$p=[Convert]::FromBase64String([Console]::In.ReadToEnd());$b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,'CurrentUser');[Text.Encoding]::UTF8.GetString($b)",
    blob,
  );
  return decoded || undefined;
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
  let raw: string;
  try {
    raw = await readFile(globalCredentialFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 1, credentials: {} };
    throw error;
  }
  try {
    const value = JSON.parse(raw) as CredentialFile;
    if (
      value?.schemaVersion === 1 &&
      value.credentials &&
      typeof value.credentials === "object"
    )
      return value;
    throw new Error("지원하지 않는 자격 증명 저장 형식입니다.");
  } catch {
    // Keep the unreadable bytes instead of letting the next write erase them.
    const backup = `${globalCredentialFile()}.corrupt-${Date.now()}.json`;
    await rename(globalCredentialFile(), backup);
    process.stderr.write(
      `자격 증명 파일을 읽지 못해 ${backup}로 보존하고 빈 저장소로 시작합니다.\n`,
    );
    return { schemaVersion: 1, credentials: {} };
  }
}

async function writeFileStore(store: CredentialFile): Promise<void> {
  const dir = globalConfigDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32")
    try {
      await chmod(dir, 0o700);
    } catch {
      // A directory we do not own keeps its existing permissions.
    }
  const path = globalCredentialFile();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // A fresh file with the right mode, then an atomic replace: an interrupted write
    // can never truncate the store or leave an existing file at a looser mode.
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32")
      try {
        await chmod(temporary, 0o600);
      } catch {
        // Windows has no POSIX mode; the file stays in the user's private profile.
      }
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file was never created or is already gone.
    }
    throw error;
  }
}

export async function getCredential(
  connectionId: string,
  envName?: string,
): Promise<string | undefined> {
  const keychain = await readKeychain(connectionId);
  if (keychain) return keychain;
  const stored = (await readFileStore()).credentials[connectionId];
  if (stored?.trim()) return await resolveStored(stored.trim());
  return envName ? process.env[envName] : undefined;
}

/** Decrypts a DPAPI-protected file entry; a plaintext entry is returned unchanged. */
async function resolveStored(value: string): Promise<string | undefined> {
  if (!value.startsWith(DPAPI_PREFIX)) return value;
  const secret = await unprotect(value.slice(DPAPI_PREFIX.length));
  if (!secret)
    throw new Error(
      "저장된 API 키를 복호화하지 못했습니다. 이 사용자 계정이 아니거나 PowerShell을 사용할 수 없습니다. ralph auth setup으로 다시 등록해 주세요.",
    );
  return secret;
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
  const protectedValue = await protect(secret.trim());
  store.credentials[connectionId] = protectedValue
    ? `${DPAPI_PREFIX}${protectedValue}`
    : secret.trim();
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

/** Human-readable location and protection of the stored secret, for status output only. */
export function describeStore(source: CredentialSource | undefined): string {
  if (source === "keychain") return "OS 키체인";
  if (source === "file")
    return `${globalCredentialFile()}${fileStoreProtected() ? " (DPAPI 암호화)" : " (평문, 사용자 전용 권한)"}`;
  if (source === "environment") return "환경변수";
  return "미설정";
}

/** True when the file fallback is (or would be) DPAPI-protected on this host. */
export function fileStoreProtected(): boolean {
  return encryptionMode() === "dpapi" && !fileStoreForced();
}
