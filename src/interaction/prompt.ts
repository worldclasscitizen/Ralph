import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { RalphError } from "../util.js";

export interface PromptOption {
  value: string;
  label: string;
  note?: string;
  disabled?: boolean;
}

export interface Prompt {
  readonly interactive: boolean;
  info(message: string): void;
  selectOne(
    question: string,
    options: PromptOption[],
    fallback?: string,
  ): Promise<string>;
  selectMany(
    question: string,
    options: PromptOption[],
    preselected?: string[],
  ): Promise<string[]>;
  askSecret(question: string): Promise<string>;
  confirm(question: string, fallback?: boolean): Promise<boolean>;
}

interface Streams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

export function createPrompt(streams: Streams = { input: stdin, output: stdout }): Prompt {
  const { input, output } = streams;
  const interactive = Boolean(input.isTTY && output.isTTY);

  const info = (message: string) => output.write(`${message}\n`);

  async function ask(question: string): Promise<string> {
    const rl = createInterface({ input, output });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }

  function requireInteractive(action: string): void {
    if (interactive) return;
    throw new RalphError(
      `${action}에는 대화형 터미널이 필요합니다. 비대화형 실행에서는 --provider, --method, --key-stdin, --key-env, --models 플래그를 사용해 주세요.`,
      "interactive_required",
      2,
    );
  }

  function describe(options: PromptOption[]): string {
    return options
      .map(
        (option, index) =>
          `  ${index + 1}) ${option.label}${option.note ? ` — ${option.note}` : ""}${option.disabled ? " (사용 불가)" : ""}`,
      )
      .join("\n");
  }

  function resolveTokens(
    tokens: string[],
    options: PromptOption[],
  ): string[] {
    const chosen: string[] = [];
    for (const token of tokens) {
      const normalized = token.trim();
      if (!normalized) continue;
      const byIndex = Number.parseInt(normalized, 10);
      const option = Number.isInteger(byIndex) && String(byIndex) === normalized
        ? options[byIndex - 1]
        : options.find((item) => item.value === normalized || item.label === normalized);
      if (!option || option.disabled)
        throw new RalphError(
          `선택할 수 없는 항목입니다: ${normalized}`,
          "invalid_argument",
          2,
        );
      if (!chosen.includes(option.value)) chosen.push(option.value);
    }
    return chosen;
  }

  return {
    interactive,
    info,
    async selectOne(question, options, fallback) {
      requireInteractive("공급자 선택");
      if (!options.length)
        throw new RalphError("선택할 수 있는 항목이 없습니다.", "invalid_argument", 2);
      if (options.length === 1 && fallback === options[0]!.value && options[0]!.disabled)
        throw new RalphError("선택할 수 있는 항목이 없습니다.", "invalid_argument", 2);
      const answer = await ask(
        `${question}\n${describe(options)}\n선택 [1-${options.length}]${fallback ? ` (기본 ${fallback})` : ""}: `,
      );
      if (!answer && fallback) return fallback;
      const [first] = resolveTokens([answer], options);
      if (!first)
        throw new RalphError("선택이 필요합니다.", "invalid_argument", 2);
      return first;
    },
    async selectMany(question, options, preselected = []) {
      requireInteractive("모델 선택");
      if (!options.length) return [];
      const answer = await ask(
        `${question}\n${describe(options)}\n쉼표로 여러 개, all=전체, Enter=기본${preselected.length ? ` (기본 ${preselected.length}개)` : ""}: `,
      );
      if (!answer) return [...preselected];
      if (/^(all|전체|\*)$/i.test(answer))
        return options.filter((option) => !option.disabled).map((option) => option.value);
      const chosen = resolveTokens(answer.split(/[\s,]+/), options);
      if (!chosen.length)
        throw new RalphError("최소 한 개를 선택해 주세요.", "invalid_argument", 2);
      return chosen;
    },
    async askSecret(question) {
      requireInteractive("API 키 입력");
      return await readSecret(question, input, output);
    },
    async confirm(question, fallback = false) {
      requireInteractive("확인");
      const answer = await ask(`${question} [${fallback ? "Y/n" : "y/N"}] `);
      if (!answer) return fallback;
      return /^(y|yes|예|승인)$/i.test(answer);
    },
  };
}

async function readSecret(
  question: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<string> {
  output.write(question);
  const tty = input as unknown as {
    setRawMode?: (value: boolean) => void;
    resume: () => void;
    pause: () => void;
  };
  emitKeypressEvents(input);
  tty.setRawMode?.(true);
  tty.resume();
  return await new Promise<string>((resolve, reject) => {
    const chars: string[] = [];
    const finish = (value: string | undefined, error?: Error) => {
      input.removeListener("keypress", onKeypress as never);
      tty.setRawMode?.(false);
      tty.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const onKeypress = (
      text: string,
      key: { name?: string; ctrl?: boolean; meta?: boolean } = {},
    ) => {
      if (key.ctrl && key.name === "c")
        return finish(undefined, new RalphError("입력이 취소되었습니다.", "cancelled", 2));
      if (key.name === "return" || key.name === "enter")
        return finish(chars.join(""));
      if (key.name === "backspace") {
        if (chars.length) {
          chars.pop();
          output.write("\b \b");
        }
        return;
      }
      if (!key.ctrl && !key.meta && text) {
        chars.push(text);
        output.write("*");
      }
    };
    input.on("keypress", onKeypress as never);
  });
}
