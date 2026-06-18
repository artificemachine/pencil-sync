import { useCallback } from "react";
import { useInput } from "ink";
import type { MappingConfig } from "../types.js";
import type { SyncEngineAPI } from "./App.js";

interface KeyboardShortcutsOptions {
  config: { mappings: MappingConfig[] };
  engine?: SyncEngineAPI | null;
  onRunDoctor?: () => Promise<void>;
  onQuit?: () => void;
}

export function useKeyboardShortcuts({
  config,
  engine,
  onRunDoctor,
  onQuit,
}: KeyboardShortcutsOptions): void {
  const handleQuit = useCallback(() => {
    if (onQuit) {
      onQuit();
    } else {
      process.exit(0);
    }
  }, [onQuit]);

  const handleSyncAll = useCallback(() => {
    if (!engine) return;
    for (const mapping of config.mappings) {
      engine.syncMapping(mapping, "manual").catch(() => {});
    }
  }, [engine, config.mappings]);

  const handleDoctor = useCallback(() => {
    if (onRunDoctor) {
      onRunDoctor().catch(() => {});
    }
  }, [onRunDoctor]);

  useInput((input) => {
    if (input === "q") handleQuit();
    else if (input === "s") handleSyncAll();
    else if (input === "d") handleDoctor();
  });
}
