/** Turn raw application output into plain-language causes. */
const RULES: Array<[RegExp, string, string?]> = [
  [/EADDRINUSE|address already in use|port is already (in use|allocated)|Only one usage of each socket address/i, "The port is already in use by another program.", "rynk start --port <other-port>"],
  [/command not found|: not found|ENOENT|is not recognized as an internal or external command|No such file or directory/i, "A required tool or file is missing.", "rynk doctor"],
  [/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find package/i, "Node dependencies are missing or out of date.", "Delete node_modules and run rynk again"],
  [/ModuleNotFoundError|No module named|ImportError/i, "Python dependencies are missing.", "Delete .venv and run rynk again"],
  [/EACCES|permission denied/i, "Permission denied.", "Use a port above 1024 and check file permissions"],
  [/SyntaxError|IndentationError|error TS\d+|Compilation failed|error\[E\d+\]/i, "The code failed to compile or has a syntax error.", "rynk logs"],
  [/out of memory|heap limit|OOMKilled|JavaScript heap/i, "The application ran out of memory."],
  [/Cannot connect to the Docker daemon|docker daemon is not running/i, "Docker isn't running.", "Start Docker Desktop, then run rynk again"],
  [/ECONNREFUSED.*(5432|3306|6379|27017)/i, "The app can't reach its database.", "Start the database the app depends on"],
];

export function explainOutput(lines: string[]): { causes: string[]; suggestions: string[] } {
  const text = lines.join("\n");
  const causes: string[] = [];
  const suggestions: string[] = [];
  for (const [re, cause, fix] of RULES) {
    if (re.test(text)) {
      causes.push(cause);
      if (fix) suggestions.push(fix);
    }
  }
  return { causes, suggestions };
}
