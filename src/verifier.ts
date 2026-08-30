import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectConfig } from "./types.js";
import { runCommand } from "./util.js";

export interface VerifierResult {
  ok: boolean;
  exitCode: number;
  summary: string;
  commands: Array<{ command: string; exitCode: number; stdout: string; stderr: string }>;
}

export async function runVerifier(projectRoot: string, config: ProjectConfig, contractCommands: string[], requiredArtifacts: string[] = []): Promise<VerifierResult> {
  const commands = contractCommands.length ? contractCommands : config.verifierCommands;
  const rows: VerifierResult["commands"] = [];
  for (const artifact of requiredArtifacts) {
    const target = resolve(projectRoot, artifact);
    const rel = relative(projectRoot, target);
    let exitCode = 0;
    let stderr = "";
    if (!artifact || isAbsolute(artifact) || rel === ".." || rel.startsWith(`..${sep}`)) {
      exitCode = 2; stderr = "필수 산출물 경로는 프로젝트 내부 상대 경로여야 합니다.";
    } else {
      try { if ((await lstat(target)).isSymbolicLink()) throw new Error("심볼릭 링크는 산출물 증거로 허용하지 않습니다."); }
      catch (error) { exitCode = 1; stderr = error instanceof Error ? error.message : String(error); }
    }
    rows.push({ command: `artifact ${artifact}`, exitCode, stdout: exitCode === 0 ? "존재 확인" : "", stderr });
    if (exitCode !== 0) break;
  }
  if (rows.some((row) => row.exitCode !== 0)) return { ok: false, exitCode: rows.find((row) => row.exitCode !== 0)!.exitCode, summary: rows.map((row) => `$ ${row.command}\nexit=${row.exitCode}\n${row.stdout}\n${row.stderr}`).join("\n\n"), commands: rows };
  for (const command of commands) {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
    const result = await runCommand(shell, args, { cwd: projectRoot, timeoutMs: 900_000 });
    rows.push({ command, exitCode: result.exitCode, stdout: result.stdout.slice(-32_000), stderr: result.stderr.slice(-32_000) });
    if (result.exitCode !== 0) break;
  }
  const ok = rows.length > 0 && rows.every((row) => row.exitCode === 0);
  return {
    ok,
    exitCode: ok ? 0 : rows.find((row) => row.exitCode !== 0)?.exitCode ?? 1,
    summary: rows.map((row) => `$ ${row.command}\nexit=${row.exitCode}\n${row.stdout}\n${row.stderr}`).join("\n\n").slice(-64_000),
    commands: rows,
  };
}
