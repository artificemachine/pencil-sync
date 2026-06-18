import React from "react";
import { Box, Text } from "ink";
import type { MappingConfig, MappingState } from "../types.js";
import { timeSince } from "./utils.js";

interface MappingPanelProps {
  mapping: MappingConfig;
  state: MappingState | null | undefined;
  budgetUsed?: number;
  budgetMax?: number;
}

export function MappingPanel({ mapping, state }: MappingPanelProps): React.JSX.Element {
  const trackedFiles = state ? Object.keys(state.codeHashes).length : 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color="cyan">
        {mapping.id}
      </Text>
      <Text dimColor>
        .pen: {mapping.penFile}  code: {mapping.codeDir}
      </Text>
      <Text>
        direction: <Text color="yellow">{mapping.direction}</Text>
      </Text>
      {state ? (
        <>
          <Text>
            last sync: <Text color="green">{timeSince(state.lastSyncTimestamp)}</Text>{" "}
            ({state.lastSyncDirection})
          </Text>
          <Text>tracked: {trackedFiles} code file{trackedFiles !== 1 ? "s" : ""}</Text>
        </>
      ) : (
        <Text color="yellow">not yet synced</Text>
      )}
    </Box>
  );
}
