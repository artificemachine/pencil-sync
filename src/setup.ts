import { writeFile, mkdir, access } from "node:fs/promises";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { detectFramework, detectStyling, findPenFiles } from "./config.js";
import { log } from "./logger.js";

const STEP_COUNT = 7;
const STEP_LABELS = [
  "Project name",
  "Design file",
  "Code directory",
  "Framework",
  "Styling",
  "Sync direction",
  "Budget",
];

export interface WizardIO {
  ask(question: string, defaultVal?: string): Promise<string>;
  print(msg: string): void;
  printSection(title: string): void;
  printStep(n: number, total: number, label: string): void;
  printDetected(label: string, value: string): void;
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
    printSection(title: string) {
      console.log(chalk.bold(`\n── ${title} ──`));
    },
    printStep(n: number, total: number, label: string) {
      console.log(`${chalk.cyan(`[${n}/${total}]`)} ${chalk.dim(label)}`);
    },
    printDetected(label: string, value: string) {
      console.log(`  ${label}: ${chalk.yellow(value)} ${chalk.dim("(auto-detected)")}`);
    },
  };
}

async function promptPenFileWithBack(
  io: WizardIO,
  searchDir: string,
  prevValue?: string,
): Promise<string | null> {
  const found = await findPenFiles(searchDir);
  if (found.length === 0) {
    const ans = await io.ask("Path to your .pen file (manual entry)", prevValue ?? "./design.pen");
    return ans.toLowerCase() === "back" ? null : ans;
  }
  io.print("\nFound .pen files:");
  found.forEach((p, i) => io.print(`  [${i + 1}] ${p}`));
  io.print(`  [m] Enter path manually`);
  const choice = await io.ask("Select a .pen file", "1");
  if (choice.toLowerCase() === "back") return null;
  if (choice === "m") {
    const manual = await io.ask("Path to your .pen file", prevValue ?? found[0]);
    return manual.toLowerCase() === "back" ? null : manual;
  }
  const idx = parseInt(choice, 10) - 1;
  if (idx >= 0 && idx < found.length) return found[idx];
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
  const answerMap: Record<string, string | undefined> = {
    "project name": defaults.projectName,
    "pen file": defaults.penFile,
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
    printSection(_title: string) { /* silent in non-interactive */ },
    printStep(_n: number, _total: number, _label: string) { /* silent in non-interactive */ },
    printDetected(_label: string, _value: string) { /* silent in non-interactive */ },
  };
}

function printSummary(io: WizardIO, collected: Record<string, string>): void {
  io.printSection("Summary");
  for (const [key, value] of Object.entries(collected)) {
    io.print(`  ${key}: ${value}`);
  }
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

  wizard.printSection("Welcome to pencil-sync setup!");

  // Auto-detect framework and styling
  const detectedFramework = await detectFramework(cwd);
  const detectedStyling = await detectStyling(cwd);

  // Initialize collected from opts.defaults (supports restart with prior answers as defaults)
  const collected: Record<string, string> = {
    projectName: defaults.projectName ?? "",
    penFile: defaults.penFile ?? "",
    codeDir: defaults.codeDir ?? "",
    framework: defaults.framework ?? "",
    styling: defaults.styling ?? "",
    direction: defaults.direction ?? "",
    budget: defaults.budget ?? "",
  };

  // Step descriptors — each run() returns null to signal "go back"
  const steps: Array<{
    key: string;
    label: string;
    run: (io: WizardIO, c: Record<string, string>) => Promise<string | null>;
  }> = [
    {
      key: "projectName",
      label: STEP_LABELS[0],
      run: async (io, c) => {
        const ans = await io.ask("Project name", c.projectName || basename(cwd));
        return ans.toLowerCase() === "back" ? null : ans;
      },
    },
    {
      key: "penFile",
      label: STEP_LABELS[1],
      run: async (io, c) => promptPenFileWithBack(io, cwd, c.penFile || undefined),
    },
    {
      key: "codeDir",
      label: STEP_LABELS[2],
      run: async (io, c) => {
        const ans = await io.ask("Code directory", c.codeDir || "./src");
        return ans.toLowerCase() === "back" ? null : ans;
      },
    },
    {
      key: "framework",
      label: STEP_LABELS[3],
      run: async (io, c) => {
        io.printDetected("Framework", detectedFramework);
        const ans = await io.ask(
          "Framework (nextjs/react/vue/svelte/astro/unknown)",
          c.framework || detectedFramework,
        );
        return ans.toLowerCase() === "back" ? null : ans;
      },
    },
    {
      key: "styling",
      label: STEP_LABELS[4],
      run: async (io, c) => {
        io.printDetected("Styling", detectedStyling);
        const ans = await io.ask(
          "Styling system (tailwind/css-modules/styled-components/css/unknown)",
          c.styling || detectedStyling,
        );
        return ans.toLowerCase() === "back" ? null : ans;
      },
    },
    {
      key: "direction",
      label: STEP_LABELS[5],
      run: async (io, c) => {
        const VALID = ["both", "pen-to-code", "code-to-pen"];
        let ans: string;
        do {
          ans = await io.ask("Sync direction (both/pen-to-code/code-to-pen)", c.direction || "both");
          if (ans.toLowerCase() === "back") return null;
          if (!VALID.includes(ans)) {
            io.print(`  Invalid direction "${ans}". Enter one of: both, pen-to-code, code-to-pen.`);
          }
        } while (!VALID.includes(ans));
        return ans;
      },
    },
    {
      key: "budget",
      label: STEP_LABELS[6],
      run: async (io, c) => {
        const ans = await io.ask("Max budget in USD", c.budget || "0.5");
        return ans.toLowerCase() === "back" ? null : ans;
      },
    },
  ];

  // Step loop with back navigation + confirmation
  let stepIndex = 0;
  let confirmed = false;

  while (!confirmed) {
    // Run each step, supporting "back"
    while (stepIndex < steps.length) {
      const step = steps[stepIndex];
      wizard.printStep(stepIndex + 1, STEP_COUNT, step.label);
      const result = await step.run(wizard, collected);
      if (result === null) {
        if (stepIndex === 0) {
          wizard.print("Already at step 1.");
          // Stay at step 0 — re-run it in the next iteration
        } else {
          stepIndex--;
        }
      } else {
        collected[step.key] = result;
        stepIndex++;
      }
    }

    // Confirmation summary
    printSummary(wizard, collected);
    const confirm = await wizard.ask("Confirm? (y/n/restart)", "y");
    if (confirm.toLowerCase() === "n") {
      wizard.print("Setup aborted. No files written.");
      return;
    }
    if (confirm.toLowerCase() === "restart") {
      return runSetup(wizard, {
        cwd,
        isTTY: true,
        nonInteractive: false,
        defaults: collected as SetupDefaults,
      });
    }
    if (confirm.toLowerCase() === "back") {
      stepIndex = steps.length - 1; // go back to step 7 (budget)
      // continue outer while loop
    } else {
      confirmed = true;
    }
  }

  // Extract final values
  const projectName = collected.projectName;
  const penFile = collected.penFile;
  const codeDir = collected.codeDir;
  const framework = collected.framework;
  const styling = collected.styling;
  const direction = collected.direction;
  const maxBudgetUsd = parseFloat(collected.budget) || 0.5;

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
