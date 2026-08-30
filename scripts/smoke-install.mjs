import { execFile } from "node:child_process";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const npmCli = process.env.npm_execpath;
const runNpm = async (args, options) => npmCli
  ? await exec(process.execPath, [npmCli, ...args], options)
  : await exec("npm", args, options);
const source = resolve(import.meta.dirname, "..");
const temp = await mkdtemp(join(tmpdir(), "ralph-pack-smoke-"));
const project = join(temp, "project");
await import("node:fs/promises").then(({ mkdir }) => mkdir(project));

await runNpm(["pack", "--pack-destination", temp], { cwd: source });
const archive = (await readdir(temp)).find((name) => name.endsWith(".tgz"));
if (!archive) throw new Error("npm pack archive가 생성되지 않았습니다.");
await runNpm(["init", "-y"], { cwd: project });
await runNpm(["install", join(temp, archive)], { cwd: project });
await exec("git", ["init"], { cwd: project });
await exec("git", ["config", "user.email", "ralph@example.invalid"], { cwd: project });
await exec("git", ["config", "user.name", "Ralph Smoke"], { cwd: project });
await writeFile(join(project, ".gitignore"), "node_modules/\n", "utf8");
await exec("git", ["add", "package.json", "package-lock.json", ".gitignore"], { cwd: project });
await exec("git", ["commit", "-m", "baseline"], { cwd: project });
const binary = join(project, "node_modules", ".bin", process.platform === "win32" ? "ralph.cmd" : "ralph");
await stat(binary);
const cli = join(project, "node_modules", "@worldclasscitizen", "ralph", "dist", "cli.js");
const version = await exec(process.execPath, [cli, "--version"], { cwd: project });
if (!version.stdout.includes("0.1.0-beta.0")) throw new Error("설치된 binary 버전이 올바르지 않습니다.");
await exec(process.execPath, [cli, "init", "--project", project, "--json"], {
  cwd: temp,
  env: { ...process.env, RALPH_CATALOG_URL: "http://127.0.0.1:1/catalog.json" },
});
await stat(join(project, ".git", "ralph", "config.json"));
for (const forbidden of [".ralph", ".antigravity", "PROMPT.md"]) {
  try { await stat(join(project, forbidden)); throw new Error(`프로젝트 루트에 금지된 제어 파일이 생성되었습니다: ${forbidden}`); }
  catch (error) { if (error instanceof Error && error.message.startsWith("프로젝트 루트")) throw error; }
}
process.stdout.write(`OK: npm archive ${archive} 설치와 Git 내부 상태 초기화를 확인했습니다.\n`);
