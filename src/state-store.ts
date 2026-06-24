import { readFile, writeFile, unlink, copyFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readdir, rename } from "node:fs/promises";
import { join, relative, resolve, dirname, basename } from "node:path";
import { log } from "./logger.js";
import { extractErrorMessage } from "./utils.js";
import { IGNORED_DIRS } from "./ignored-dirs.js";
import { matches } from "./glob-matcher.js";
import type { SyncState, MappingState, MappingConfig, SyncDirection, PenNodeSnapshot, SyncResult } from "./types.js";

// Re-export for backward compatibility (tests import globToRegex from state-store)
export { globToRegex } from "./glob-matcher.js";

function createEmptyState(): SyncState {
  return { version: 1, mappings: {} };
}

interface PersistedState extends SyncState {
  _checksum?: string;
}

let _saveCounter = 0;

export class StateStore {
  private state: SyncState = createEmptyState();

  constructor(private stateFilePath: string) {}

  async load(): Promise<void> {
    await this.ensureDir();
    await this.migrateOldFlatFile();
    await this.cleanupOrphanedTmp();

    try {
      const raw = await readFile(this.stateFilePath, "utf-8");
      const recovered = this.parseValidatedState(raw);
      if (recovered !== null) {
        this.state = recovered;
        log.debug(`Loaded state with ${Object.keys(this.state.mappings).length} mappings`);
        return;
      }
      // File exists but is corrupt — attempt backup recovery
      log.warn("State file corrupt — attempting recovery from backup");
      const backupState = await this.tryReadBackup();
      if (backupState !== null) {
        this.state = backupState;
        log.warn("Recovered state from backup");
        return;
      }
      log.warn("State file and backup both corrupt, falling back to empty state");
      this.state = createEmptyState();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        log.debug("No existing state file, starting fresh");
      } else {
        log.warn(`Failed to read state file (${extractErrorMessage(err)}), falling back to empty state`);
      }
      this.state = createEmptyState();
    }
  }

  // Atomic write: write to a unique .tmp then rename to avoid concurrent-save corruption
  async save(): Promise<void> {
    await this.ensureDir();

    // Create backup before overwriting (if state file exists)
    await this.createBackup();

    const tmp = `${this.stateFilePath}.${process.pid}.${++_saveCounter}.tmp`;

    // Add checksum to detect corruption/tampering
    const checksum = this.computeChecksum(this.state);
    const persistedState: PersistedState = { ...this.state, _checksum: checksum };

    await writeFile(tmp, JSON.stringify(persistedState, null, 2));
    await rename(tmp, this.stateFilePath);
    log.debug("State saved");
  }

  getMappingState(mappingId: string): MappingState | undefined {
    return this.state.mappings[mappingId];
  }

  clearMappingState(mappingId: string): void {
    delete this.state.mappings[mappingId];
  }

  async updateMappingState(
    mapping: MappingConfig,
    direction: SyncDirection,
    penSnapshot?: PenNodeSnapshot,
  ): Promise<void> {
    const penHash = await hashFile(mapping.penFile);
    const codeHashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);

    this.state.mappings[mapping.id] = {
      mappingId: mapping.id,
      penHash,
      codeHashes,
      lastSyncTimestamp: Date.now(),
      lastSyncDirection: direction,
      penSnapshot,
    };

    await this.save();
  }

  async initMappingState(mapping: MappingConfig): Promise<void> {
    if (this.state.mappings[mapping.id]) return;
    await this.updateMappingState(mapping, mapping.direction === "both" ? "pen-to-code" : mapping.direction);
  }

  private parseValidatedState(raw: string): SyncState | null {
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      if (!this.isValidState(parsed)) return null;
      if (parsed._checksum) {
        const { _checksum, ...dataOnly } = parsed;
        if (this.computeChecksum(dataOnly) !== _checksum) return null;
      }
      const { _checksum, ...stateData } = parsed;
      return stateData;
    } catch {
      return null;
    }
  }

  private async tryReadBackup(): Promise<SyncState | null> {
    try {
      const raw = await readFile(this.stateFilePath + ".backup", "utf-8");
      return this.parseValidatedState(raw);
    } catch {
      return null;
    }
  }

  private isValidState(obj: unknown): obj is PersistedState {
    if (typeof obj !== "object" || obj === null) return false;
    const state = obj as Partial<PersistedState>;
    if (typeof state.version !== "number") return false;
    if (typeof state.mappings !== "object" || state.mappings === null) return false;
    return true;
  }

  private computeChecksum(data: SyncState): string {
    // Use deterministic JSON serialization (sorted keys at all levels)
    const serialized = JSON.stringify(data, (key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.keys(value)
          .sort()
          .reduce((sorted: Record<string, unknown>, k) => {
            sorted[k] = value[k];
            return sorted;
          }, {});
      }
      return value;
    });
    return createHash("sha256").update(serialized).digest("hex");
  }

  async writeLastRun(result: SyncResult): Promise<void> {
    try {
      const lastRunPath = join(dirname(this.stateFilePath), "last-run.json");
      await writeFile(lastRunPath, JSON.stringify(result, null, 2));
    } catch (err) {
      log.warn(`Failed to write last-run.json: ${extractErrorMessage(err)}`);
    }
  }

  private async ensureDir(): Promise<void> {
    try {
      await mkdir(dirname(this.stateFilePath), { recursive: true });
    } catch (err) {
      log.warn(`Failed to create state directory: ${extractErrorMessage(err)}`);
    }
  }

  private isDefaultStatePath(): boolean {
    return (
      basename(this.stateFilePath) === "state.json" &&
      basename(dirname(this.stateFilePath)) === ".pencil-sync"
    );
  }

  private oldFlatStatePath(): string {
    return join(dirname(dirname(this.stateFilePath)), ".pencil-sync-state.json");
  }

  private async migrateOldFlatFile(): Promise<void> {
    if (!this.isDefaultStatePath()) return;

    const oldPath = this.oldFlatStatePath();
    const newPathExists = await readFile(this.stateFilePath, "utf-8").then(() => true).catch(() => false);
    if (newPathExists) return;

    try {
      await readFile(oldPath, "utf-8"); // check it exists
      await rename(oldPath, this.stateFilePath);
      log.debug("Migrated .pencil-sync-state.json to .pencil-sync/state.json");
    } catch {
      // Old file doesn't exist — nothing to migrate
    }
  }

  private async cleanupOrphanedTmp(): Promise<void> {
    const tmpFile = this.stateFilePath + ".tmp";
    try {
      await unlink(tmpFile);
      log.debug("Cleaned up orphaned .tmp file");
    } catch {
      // No orphaned tmp file — OK
    }
  }

  private async createBackup(): Promise<void> {
    try {
      const backupPath = this.stateFilePath + ".backup";
      await copyFile(this.stateFilePath, backupPath);
      log.debug("Created state backup");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        log.debug("No existing state to backup");
      } else {
        log.warn(`Failed to create state backup: ${extractErrorMessage(err)}`);
      }
    }
  }

}

export async function hashFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "";
  }
}

export async function hashCodeDir(
  codeDir: string,
  globs: string[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const files = await collectFiles(codeDir, globs);

  for (const file of files) {
    const relPath = relative(codeDir, file).replaceAll("\\", "/");
    hashes[relPath] = await hashFile(file);
  }

  return hashes;
}

async function collectFiles(
  dir: string,
  globs: string[],
): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = resolve(join(currentDir, entry.name));
      // Guard against symlinks that resolve outside the root dir
      if (!fullPath.startsWith(resolve(dir))) continue;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = relative(dir, fullPath).replaceAll("\\", "/");
        if (matches(relPath, globs)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(dir);
  return results.sort();
}

export function diffHashes(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const changed: string[] = [];

  for (const [file, hash] of Object.entries(after)) {
    if (before[file] !== hash) {
      changed.push(file);
    }
  }
  for (const file of Object.keys(before)) {
    if (!(file in after)) {
      changed.push(file);
    }
  }

  return changed.sort();
}

