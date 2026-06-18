import React from "react";
import { Box, Text } from "ink";
import type { PencilSyncConfig, MappingState } from "../types.js";
import { MappingPanel } from "./MappingPanel.js";

interface AppProps {
  config: PencilSyncConfig;
  states: Record<string, MappingState | undefined>;
}

export function App({ config, states }: AppProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>pencil-sync TUI</Text>
      {config.mappings.map((mapping) => (
        <MappingPanel
          key={mapping.id}
          mapping={mapping}
          state={states[mapping.id] ?? null}
        />
      ))}
    </Box>
  );
}
