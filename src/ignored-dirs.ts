export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next"]);

export const IGNORED_GLOBS = [...IGNORED_DIRS].map((name) => `**/${name}/**`);
