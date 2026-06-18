import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import { StateStore } from "../state-store.js";
import type { PencilSyncConfig, MappingState } from "../types.js";

export async function startTui(config: PencilSyncConfig): Promise<void> {
  const store = new StateStore(config.settings.stateFile);
  await store.load();

  const states: Record<string, MappingState | undefined> = {};
  for (const mapping of config.mappings) {
    states[mapping.id] = store.getMappingState(mapping.id);
  }

  render(React.createElement(App, { config, states }));
}
