import * as fs from "fs";
import * as path from "path";

const _SKIP_DIR_NAMES = new Set([
  "node_modules", "dist", "build", "out", "target", ".git", ".venv", ".next", "coverage",
]);

const _EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".java": "java",
  ".ts": "javascript",
  ".tsx": "javascript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
};

/**
 * Cheap, best-effort majority-vote over file extensions under a root —
 * just picks a sensible default for the language QuickPick, never the
 * only way to choose it. Stops descending after a fixed file budget so a
 * huge repo doesn't make the "Scan" button feel unresponsive before the
 * picker even opens.
 */
export function detectLikelyLanguage(root: string, fileBudget = 2000): string | undefined {
  const counts: Record<string, number> = {};
  let visited = 0;

  function walk(dir: string): void {
    if (visited >= fileBudget) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= fileBudget) {
        return;
      }
      if (entry.isDirectory()) {
        if (!_SKIP_DIR_NAMES.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
        continue;
      }
      visited++;
      const lang = _EXTENSION_TO_LANGUAGE[path.extname(entry.name)];
      if (lang) {
        counts[lang] = (counts[lang] ?? 0) + 1;
      }
    }
  }

  walk(root);

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0];
}
