import { writeFile, mkdir, access } from "node:fs/promises";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import { detectFramework, detectStyling, findPenFiles } from "./config.js";
import { log } from "./logger.js";

export interface WizardIO {
  ask(question: string, defaultVal?: string): Promise<string>;
  print(msg: string): void;
}

export interface SetupDefaults {
  projectName?: string;
  penFile?: string;
  codeDir?: string;
  framework?: string;
  styling?: string;
  direction?: string;
  budget?: string;
}

export interface SetupOptions {
  cwd?: string;
  isTTY?: boolean;
  nonInteractive?: boolean;
  defaults?: SetupDefaults;
}

export function createReadlineIO(): WizardIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question, defaultVal) {
      return new Promise((resolve) => {
        const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
        rl.question(prompt, (answer) => {
          resolve(answer.trim() || defaultVal || "");
        });
      });
    },
    print(msg) {
      console.log(msg);
    },
  };
}

async function promptPenFile(io: WizardIO, searchDir: string): Promise<string> {
  const found = await findPenFiles(searchDir);
  if (found.length === 0) {
    return io.ask("Path to your .pen file (manual entry)", "./design.pen");
  }
  io.print("\nFound .pen files:");
  found.forEach((p, i) => io.print(`  [${i + 1}] ${p}`));
  io.print(`  [m] Enter path manually`);
  const choice = await io.ask("Select a .pen file", "1");
  if (choice === "m") {
    return io.ask("Path to your .pen file", found[0]);
  }
  const idx = parseInt(choice, 10) - 1;
  if (idx >= 0 && idx < found.length) {
    return found[idx];
  }
  return found[0];
}

async function configExists(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, "pencil-sync.config.json"));
    return true;
  } catch {
    return false;
  }
}

function createNonInteractiveIO(defaults: SetupDefaults): WizardIO {
  // Maps question keywords to defaults fields for accurate non-interactive answers
  const answerMap: Record<string, string | undefined> = {
    "project name": defaults.projectName,
    "pen file": defaults.penFile,
    "pen": defaults.penFile,
    "code directory": defaults.codeDir,
    "framework": defaults.framework,
    "styling": defaults.styling,
    "direction": defaults.direction,
    "budget": defaults.budget,
  };

  return {
    async ask(question: string, defaultVal?: string): Promise<string> {
      const lq = question.toLowerCase();
      for (const [key, val] of Object.entries(answerMap)) {
        if (lq.includes(key) && val !== undefined) return val;
      }
      return defaultVal ?? "";
    },
    print(_msg: string) { /* silent in non-interactive */ },
  };
}

export async function runSetup(io?: WizardIO, opts: SetupOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const isTTY = opts.isTTY ?? process.stdin.isTTY;
  const nonInteractive = opts.nonInteractive ?? false;
  const defaults = opts.defaults ?? {};

  // Non-interactive mode: validate required fields, then run with preset answers
  if (nonInteractive) {
    if (!defaults.penFile || !defaults.codeDir) {
      const msg = "Error: --non-interactive requires --pen-file and --code-dir to be specified.";
      (io ?? { print: console.log }).print(msg);
      return;
    }
    const niIO = createNonInteractiveIO(defaults);
    return runSetup(niIO, {
      cwd,
      isTTY: true,
      nonInteractive: false,
      defaults,
    });
  }

  const wizard = io ?? createReadlineIO();

  if (!isTTY && !io) {
    wizard.print("Error: pencil-sync setup requires an interactive terminal (TTY). Run this command in your terminal, not in a pipe or CI script.");
    return;
  }

  // Check if config already exists
  if (await configExists(cwd)) {
    const overwrite = await wizard.ask("A pencil-sync.config.json already exists. Overwrite? (y/n)", "n");
    if (overwrite.toLowerCase() !== "y") {
      wizard.print("Setup aborted. Existing config unchanged.");
      return;
    }
  }

  wizard.print("\nWelcome to pencil-sync setup!\n");

  // Auto-detect framework and styling
  const detectedFramework = await detectFramework(cwd);
  const detectedStyling = await detectStyling(cwd);

  // Step 1 — project name
  const defaultName = basename(cwd);
  const projectName = await wizard.ask("Project name", defaultName);

  // Step 2 — pen file
  const penFile = await promptPenFile(wizard, cwd);

  // Step 3 — code directory
  const codeDir = await wizard.ask("Code directory", "./src");

  // Step 4 — framework
  const framework = await wizard.ask(
    `Framework (nextjs/react/vue/svelte/astro/unknown)`,
    detectedFramework,
  );

  // Step 5 — styling
  const styling = await wizard.ask(
    `Styling system (tailwind/css-modules/styled-components/css/unknown)`,
    detectedStyling,
  );

  // Step 6 — sync direction
  const direction = await wizard.ask("Sync direction (both/pen-to-code/code-to-pen)", "both");

  // Step 7 — budget
  const budgetStr = await wizard.ask("Max budget in USD", "0.5");
  const maxBudgetUsd = parseFloat(budgetStr) || 0.5;

  // Write config
  const config = {
    version: 1,
    mappings: [
      {
        id: projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        penFile,
        codeDir,
        codeGlobs: ["**/*.tsx", "**/*.ts", "**/*.css", "**/*.vue", "**/*.svelte"],
        framework,
        styling,
        direction,
      },
    ],
    settings: {
      debounceMs: 2000,
      model: "claude-sonnet-4-6",
      maxBudgetUsd,
      conflictStrategy: "prompt",
      stateFile: ".pencil-sync/state.json",
      logLevel: "info",
    },
  };

  const configPath = join(cwd, "pencil-sync.config.json");
  try {
    await writeFile(configPath, JSON.stringify(config, null, 2));
    wizard.print(`\nConfig written: ${configPath}`);
  } catch (err) {
    wizard.print(`Error writing config: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Create .pencil-sync directory
  try {
    await mkdir(join(cwd, ".pencil-sync"), { recursive: true });
    wizard.print("Created .pencil-sync/ directory.");
  } catch {
    log.warn("Could not create .pencil-sync/ directory — it will be created on first sync.");
  }

  wizard.print("\nSetup complete! Run `pencil-sync doctor` to validate your configuration.");
  wizard.print("Run `pencil-sync sync --dry-run` to preview what would change.");
}
