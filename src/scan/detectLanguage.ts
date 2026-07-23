import * as fs from "fs";
import * as path from "path";

const _SKIP_DIR_NAMES = new Set([
  "node_modules", "dist", "build", "out", "target", ".git", ".venv", ".next", "coverage",
]);

const _EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".py": "python",
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

export interface ProjectLanguageInspection {
  likely: string | undefined;
  counts: Readonly<Record<string, number>>;
  visitedFiles: number;
  truncated: boolean;
}

/**
 * Cheap, best-effort majority-vote over file extensions under a root —
 * just picks a sensible default for the language QuickPick, never the
 * only way to choose it. Stops descending after a fixed file budget so a
 * huge repo doesn't make the "Scan" button feel unresponsive before the
 * picker even opens.
 */
export function inspectProjectLanguages(root: string, fileBudget = 10_000): ProjectLanguageInspection {
  const counts: Record<string, number> = {};
  let visited = 0;
  let truncated = false;

  function walk(dir: string): void {
    if (visited >= fileBudget) {
      truncated = true;
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
        truncated = true;
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
  return {
    likely: sorted[0]?.[0],
    counts,
    visitedFiles: visited,
    truncated,
  };
}

export function detectLikelyLanguage(root: string, fileBudget = 10_000): string | undefined {
  return inspectProjectLanguages(root, fileBudget).likely;
}
