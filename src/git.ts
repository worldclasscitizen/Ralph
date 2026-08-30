import { access, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { RalphError, runCommand } from "./util.js";

export async function findGitRoot(start: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(start) });
  if (result.exitCode !== 0) {
    throw new RalphError("Git 저장소 밖입니다. --project로 절대 경로를 지정해 주세요.", "not_git_repository", 2);
  }
  return result.stdout.trim();
}

export async function gitPath(projectRoot: string, child = "ralph"): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "--git-path", child], { cwd: projectRoot });
  if (result.exitCode !== 0) throw new RalphError("Git 내부 상태 경로를 찾지 못했습니다.", "git_path_failed");
  return resolve(projectRoot, result.stdout.trim());
}

export async function gitHead(projectRoot: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd: projectRoot });
  return result.exitCode === 0 ? result.stdout.trim() : "UNBORN";
}

export async function gitBranch(projectRoot: string): Promise<string> {
  const result = await runCommand("git", ["branch", "--show-current"], { cwd: projectRoot });
  return result.stdout.trim() || "DETACHED";
}

export async function gitStatus(projectRoot: string): Promise<string> {
  const result = await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: projectRoot });
  if (result.exitCode !== 0) throw new RalphError(result.stderr.trim() || "Git status에 실패했습니다.", "git_status_failed");
  return result.stdout;
}

export async function assertSafeGitStart(projectRoot: string): Promise<void> {
  const branch = await gitBranch(projectRoot);
  if (branch === "DETACHED") throw new RalphError("detached HEAD에서는 Ralph를 시작할 수 없습니다.", "unsafe_git_state");
  const stateFiles = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"];
  for (const name of stateFiles) {
    const path = await gitPath(projectRoot, name);
    try {
      await access(path);
      throw new RalphError(`${name} 상태에서는 Ralph를 시작할 수 없습니다.`, "unsafe_git_state");
    } catch (error) {
      if (error instanceof RalphError) throw error;
    }
  }
  const status = await gitStatus(projectRoot);
  if (status.trim()) {
    throw new RalphError(
      "작업 트리가 깨끗하지 않습니다. 변경을 검토해 기준 커밋으로 저장한 뒤 다시 실행해 주세요.",
      "dirty_worktree",
      3,
    );
  }
}

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)credentials\.json$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)(id_rsa|id_ed25519)$/,
];

const SECRET_CONTENT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+~=-]{12,}/i,
];

export async function assertCheckpointSafe(projectRoot: string): Promise<void> {
  const status = await gitStatus(projectRoot);
  const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    if (conflictCodes.has(line.slice(0, 2))) throw new RalphError(`Git 충돌 상태(${line.slice(0, 2)})가 감지되어 checkpoint를 차단했습니다.`, "git_conflict");
  }
  const paths = status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const raw = line.slice(3).replace(/^"|"$/g, "");
      return raw.includes(" -> ") ? raw.split(" -> ").at(-1)! : raw;
    });
  for (const path of paths) {
    if (SECRET_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
      throw new RalphError(`민감 파일 ${path}이(가) 감지되어 checkpoint를 차단했습니다.`, "secret_detected");
    }
    try {
      const content = await readFile(resolve(projectRoot, path), "utf8");
      if (SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(content))) {
        throw new RalphError(`파일 ${path}에서 비밀값 의심 패턴을 감지했습니다.`, "secret_detected");
      }
    } catch (error) {
      if (error instanceof RalphError) throw error;
    }
  }
}

export async function checkpoint(
  projectRoot: string,
  metadata: {
    runId: string;
    task: string;
    iteration: number;
    status: string;
    workerExit?: number;
    verifierExit?: number;
    score?: number;
    verdict?: string;
  },
): Promise<string> {
  await assertCheckpointSafe(projectRoot);
  const add = await runCommand("git", ["add", "-A", "--", "."], { cwd: projectRoot });
  if (add.exitCode !== 0) throw new RalphError(add.stderr.trim() || "git add에 실패했습니다.", "checkpoint_failed");
  const subject = `chore(ralph): ${metadata.task} iteration ${metadata.iteration} ${metadata.status}`;
  const body = [
    `Ralph-Run: ${metadata.runId}`,
    `Ralph-Task: ${metadata.task}`,
    `Ralph-Iteration: ${metadata.iteration}`,
    `Ralph-Status: ${metadata.status}`,
    `Ralph-Worker-Exit: ${metadata.workerExit ?? "not-run"}`,
    `Ralph-Verifier-Exit: ${metadata.verifierExit ?? "not-run"}`,
    `Ralph-Score: ${metadata.score ?? "not-scored"}`,
    `Ralph-Verdict: ${metadata.verdict ?? "unknown"}`,
  ].join("\n");
  const result = await runCommand("git", ["commit", "--allow-empty", "-m", subject, "-m", body], { cwd: projectRoot });
  if (result.exitCode !== 0) throw new RalphError(result.stderr.trim() || "Git checkpoint 생성에 실패했습니다.", "checkpoint_failed");
  return await gitHead(projectRoot);
}

export function projectLabel(projectRoot: string): string {
  return basename(projectRoot);
}
