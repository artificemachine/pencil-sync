const regexCache = new Map<string, RegExp>();

function normalizeGlob(glob: string): string {
  // Normalize Windows-style backslash path separators to forward slashes
  return glob.replaceAll("\\", "/");
}

function buildRegexSource(glob: string): string {
  let i = 0;
  let result = "";

  while (i < glob.length) {
    const ch = glob[i];

    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // Collapse consecutive **/ sequences into one to avoid ReDoS.
          // Replace (.+/)? with (?:[^/]+/)* — linear matching, no catastrophic backtracking.
          i += 3;
          while (i < glob.length && glob[i] === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
            i += 3;
          }
          result += "(?:[^/]+/)*";
        } else {
          result += ".*";
          i += 2;
        }
      } else {
        result += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      result += "[^/]";
      i++;
    } else if (ch === ".") {
      result += "\\.";
      i++;
    } else if (ch === "[") {
      result += "[";
      i++;
      // POSIX [!...] negation → regex [^...]
      if (i < glob.length && glob[i] === "!") { result += "^"; i++; }
      else if (i < glob.length && glob[i] === "^") { result += "^"; i++; }
      if (i < glob.length && glob[i] === "]") { result += "]"; i++; }
      while (i < glob.length && glob[i] !== "]") {
        result += glob[i++];
      }
      result += "]";
      if (i < glob.length) i++;
    } else if (ch === "{") {
      const braceStart = i;
      i++;
      const alts: string[] = [];
      let current = "";
      let depth = 1;
      while (i < glob.length && depth > 0) {
        const c = glob[i];
        if (c === "{") { depth++; current += c; i++; }
        else if (c === "}") {
          depth--;
          if (depth === 0) { alts.push(current); i++; }
          else { current += c; i++; }
        } else if (c === "," && depth === 1) {
          alts.push(current); current = ""; i++;
        } else {
          current += c; i++;
        }
      }
      if (depth > 0) {
        // Unterminated brace — emit the original '{...' text as escaped literal characters
        const literal = glob.slice(braceStart, i);
        result += literal.replace(/[+^$()|\\/{}]/g, "\\$&");
      } else {
        const regexAlts = alts.map((a) => buildRegexSource(a));
        result += "(?:" + regexAlts.join("|") + ")";
      }
    } else {
      result += ch.replace(/[+^$()|\\/]/g, "\\$&");
      i++;
    }
  }

  return result;
}

export function globToRegex(glob: string): RegExp {
  const cached = regexCache.get(glob);
  if (cached) return cached;
  const normalized = normalizeGlob(glob);
  const re = new RegExp(`^${buildRegexSource(normalized)}$`);
  regexCache.set(glob, re);
  return re;
}

export function matches(relPath: string, globs: string[]): boolean {
  const normalized = relPath.replaceAll("\\", "/");
  return globs.some((g) => globToRegex(g).test(normalized));
}
