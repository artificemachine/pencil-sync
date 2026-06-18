import React from "react";
import { Box, Text } from "ink";
import type { TuiSyncEvent } from "../types.js";
import { timeSince } from "./utils.js";

interface EventFeedProps {
  events: TuiSyncEvent[];
  maxItems?: number;
}

function eventColor(ev: TuiSyncEvent): string {
  if (ev.type === "error" || ev.success === false) return "red";
  if (ev.type === "conflict") return "magenta";
  if (ev.type === "warning") return "yellow";
  return "green";
}

export function EventFeed({ events, maxItems = 50 }: EventFeedProps): React.JSX.Element {
  const visible = events.slice(-maxItems);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold dimColor>Event feed</Text>
      {visible.length === 0 ? (
        <Text dimColor>No events yet.</Text>
      ) : (
        visible.map((ev, i) => (
          <Text key={i} color={eventColor(ev)}>
            [{timeSince(ev.timestamp)}] [{ev.mappingId}] {ev.message}
          </Text>
        ))
      )}
    </Box>
  );
}
