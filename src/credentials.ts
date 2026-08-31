import { commandExists, runCommand } from "./util.js";

const SERVICE = "worldclasscitizen.ralph";

export async function getCredential(connectionId: string, envName?: string): Promise<string | undefined> {
  if (process.platform === "darwin" && (await commandExists("security"))) {
    const result = await runCommand("security", ["find-generic-password", "-s", SERVICE, "-a", connectionId, "-w"]);
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  if (process.platform === "linux" && (await commandExists("secret-tool"))) {
    const result = await runCommand("secret-tool", ["lookup", "service", SERVICE, "connection", connectionId]);
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return envName ? process.env[envName] : undefined;
}

export async function setCredential(connectionId: string, secret: string): Promise<"keychain" | "unavailable"> {
  if (!secret.trim()) throw new Error("빈 비밀값은 저장할 수 없습니다.");
  if (process.platform === "darwin" && (await commandExists("security"))) {
    const result = await runCommand("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", connectionId, "-w", secret]);
    if (result.exitCode === 0) return "keychain";
    throw new Error(result.stderr.trim() || "macOS Keychain 저장에 실패했습니다.");
  }
  if (process.platform === "linux" && (await commandExists("secret-tool"))) {
    const result = await runCommand("secret-tool", ["store", "--label", `Ralph ${connectionId}`, "service", SERVICE, "connection", connectionId], { input: secret });
    if (result.exitCode === 0) return "keychain";
    throw new Error(result.stderr.trim() || "Secret Service 저장에 실패했습니다.");
  }
  return "unavailable";
}

export async function removeCredential(connectionId: string): Promise<void> {
  if (process.platform === "darwin" && (await commandExists("security"))) {
    await runCommand("security", ["delete-generic-password", "-s", SERVICE, "-a", connectionId]);
    return;
  }
  if (process.platform === "linux" && (await commandExists("secret-tool"))) {
    await runCommand("secret-tool", ["clear", "service", SERVICE, "connection", connectionId]);
  }
}
