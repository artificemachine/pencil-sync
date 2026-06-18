import { execFileSync } from "node:child_process";
import { access, constants } from "node:fs/promises";
import chalk from "chalk";
import { loadConfig } from "./config.js";
import { hashCodeDir } from "./state-store.js";
import { log } from "./logger.js";
import type { MappingConfig } from "./types.js";

export interface DoctorCheck {
  label: string;
  passed: boolean;
  detail?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  allPassed: boolean;
}

export async function checkClaudeBinary(): Promise<DoctorCheck> {
  try {
    execFileSync("claude", ["--version"], { timeout: 3000, stdio: "ignore" });
    return { label: "Claude CLI on PATH", passed: true };
  } catch {
    return {
      label: "Claude CLI on PATH",
      passed: false,
      detail: "install: npm install -g @anthropic-ai/claude-code",
    };
  }
}

async function checkMapping(mapping: MappingConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // Check (c) — pen file accessible
  try {
    await access(mapping.penFile, constants.R_OK);
    checks.push({ label: `pen file accessible (${mapping.id})`, passed: true });
  } catch {
    checks.push({
      label: `pen file accessible (${mapping.id})`,
      passed: false,
      detail: `not found: ${mapping.penFile}`,
    });
  }

  // Check (d) — code directory accessible
  try {
    await access(mapping.codeDir, constants.R_OK);
    checks.push({ label: `code directory accessible (${mapping.id})`, passed: true });
  } catch {
    checks.push({
      label: `code directory accessible (${mapping.id})`,
      passed: false,
      detail: `not found: ${mapping.codeDir}`,
    });
  }

  // Check (e) — globs match at least one file
  try {
    const hashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);
    const count = Object.keys(hashes).length;
    if (count > 0) {
      checks.push({
        label: `globs match files (${mapping.id})`,
        passed: true,
        detail: `${count} file(s) matched`,
      });
    } else {
      checks.push({
        label: `globs match files (${mapping.id})`,
        passed: false,
        detail: `no files match ${mapping.codeGlobs.join(", ")} in ${mapping.codeDir}`,
      });
    }
  } catch {
    checks.push({
      label: `globs match files (${mapping.id})`,
      passed: false,
      detail: `could not scan ${mapping.codeDir}`,
    });
  }

  return checks;
}

function printChecklist(checks: DoctorCheck[]): void {
  for (const check of checks) {
    const icon = check.passed ? chalk.green("[✓]") : chalk.red("[✗]");
    const label = check.passed ? chalk.white(check.label) : chalk.red(check.label);
    const detail = check.detail ? chalk.dim(` — ${check.detail}`) : "";
    log.info(`${icon} ${label}${detail}`);
  }
}

export async function runDoctor(configPath?: string): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // Check (a) — Claude CLI
  checks.push(await checkClaudeBinary());

  // Check (b) — config loads
  let config;
  try {
    config = await loadConfig(configPath);
    checks.push({ label: "Config valid", passed: true });
  } catch (err) {
    checks.push({ label: "Config valid", passed: false, detail: String(err) });
    printChecklist(checks);
    return { checks, allPassed: false };
  }

  // Checks (c)-(e) per mapping
  for (const mapping of config.mappings) {
    const mappingChecks = await checkMapping(mapping);
    checks.push(...mappingChecks);
  }

  // Check (f) — budget > 0
  const budget = config.settings.maxBudgetUsd;
  if (budget > 0) {
    checks.push({ label: "Budget > 0", passed: true, detail: `$${budget}` });
  } else {
    checks.push({
      label: "Budget > 0",
      passed: false,
      detail: "set maxBudgetUsd > 0 in settings",
    });
  }

  printChecklist(checks);

  const allPassed = checks.every((c) => c.passed);
  return { checks, allPassed };
}
