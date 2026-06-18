import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { PencilSyncConfig, MappingState } from "../types.js";

export async function startTui(
  config?: PencilSyncConfig,
  states?: Record<string, MappingState | undefined>,
): Promise<void> {
  if (!config) {
    console.log("TUI starting...");
    return;
  }
  render(React.createElement(App, { config, states: states ?? {} }));
}
