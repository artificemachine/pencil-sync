import React from "react";
import { Box, Text } from "ink";
import type { PencilSyncConfig, MappingState, TuiSyncEvent } from "../types.js";
import { MappingPanel } from "./MappingPanel.js";
import { EventFeed } from "./EventFeed.js";

interface AppProps {
  config: PencilSyncConfig;
  states: Record<string, MappingState | undefined>;
  events?: TuiSyncEvent[];
}

export function App({ config, states, events = [] }: AppProps): React.JSX.Element {
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
      <EventFeed events={events} />
    </Box>
  );
}
