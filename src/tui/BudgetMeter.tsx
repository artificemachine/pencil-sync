import React from "react";
import { Box, Text } from "ink";

interface BudgetMeterProps {
  used: number;
  max: number;
}

export function BudgetMeter({ used, max }: BudgetMeterProps): React.JSX.Element {
  const overBudget = used > max;
  const pct = max > 0 ? Math.min(used / max, 1) : 0;
  const barLen = 20;
  const fill = Math.round(pct * barLen);
  const bar = "█".repeat(fill) + "░".repeat(barLen - fill);
  const color = overBudget ? "red" : pct > 0.8 ? "yellow" : "green";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        Budget:{" "}
        <Text color={color}>
          ${used.toFixed(2)} / ${max.toFixed(2)}
        </Text>
        {overBudget && <Text color="red">  OVER BUDGET</Text>}
      </Text>
      <Text color={color}>[{bar}]</Text>
    </Box>
  );
}
