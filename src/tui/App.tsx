import React from "react";
import { Box, Text } from "ink";
import type { PencilSyncConfig, MappingConfig, MappingState, TuiSyncEvent, SyncResult } from "../types.js";
import { MappingPanel } from "./MappingPanel.js";
import { EventFeed } from "./EventFeed.js";
import { BudgetMeter } from "./BudgetMeter.js";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts.js";

export interface SyncEngineAPI {
  syncMapping(mapping: MappingConfig, trigger: string): Promise<SyncResult>;
}

interface AppProps {
  config: PencilSyncConfig;
  states: Record<string, MappingState | undefined>;
  events?: TuiSyncEvent[];
  budgetUsed?: number;
  engine?: SyncEngineAPI | null;
  onRunDoctor?: () => Promise<void>;
  onQuit?: () => void;
}

export function App({
  config,
  states,
  events = [],
  budgetUsed = 0,
  engine = null,
  onRunDoctor,
  onQuit,
}: AppProps): React.JSX.Element {
  useKeyboardShortcuts({ config, engine, onRunDoctor, onQuit });

  return (
    <Box flexDirection="column">
      <Text bold>pencil-sync TUI</Text>
      <Text dimColor>  s=sync  d=doctor  q=quit</Text>
      {config.mappings.map((mapping) => (
        <MappingPanel
          key={mapping.id}
          mapping={mapping}
          state={states[mapping.id] ?? null}
        />
      ))}
      <EventFeed events={events} />
      <BudgetMeter used={budgetUsed} max={config.settings.maxBudgetUsd} />
    </Box>
  );
}
