import { cmd, type BindingStrategy, type CommandSpec, type DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import { isWindows, type ProjectContext } from "../context.js";

const SOURCE_CANDIDATES = ["main.py", "app.py", "server.py", "api.py", "run.py", "wsgi.py", "asgi.py", "app/main.py", "src/main.py", "src/app.py", "streamlit_app.py"];

function venvPython(ctx: ProjectContext): string | null {
  for (const dir of [".venv", "venv", "env"]) {
    const rel = isWindows ? `${dir}\\Scripts\\python.exe` : `${dir}/bin/python`;
    if (ctx.exists(rel)) return rel;
  }
  return null;
}

function depsText(ctx: ProjectContext): string {
  return [ctx.read("requirements.txt"), ctx.read("pyproject.toml"), ctx.read("Pipfile"), ctx.read("setup.py")]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function hasDep(text: string, name: string): boolean {
  return new RegExp(`(^|[\\s"'\\[,])${name}([\\s"'\\]<>=~!;,\\[]|$)`, "m").test(text);
}

/** "app/main.py" → "app.main" */
const toModule = (file: string) => file.replace(/\.py$/, "").replace(/[\\/]/g, ".");

export const pythonDetector: Detector = {
  name: "python",
  detect(ctx: ProjectContext): DetectionResult | null {
    const markers = ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "manage.py"].filter((m) => ctx.exists(m));
    const loosePy = SOURCE_CANDIDATES.find((f) => ctx.exists(f));
    if (!markers.length && !loosePy) return null;

    const evidence = markers.map((m) => m);
    const warnings: string[] = [];
    const deps = depsText(ctx);

    // Tooling: uv > poetry > pipenv > venv/pip
    const tool = ctx.exists("uv.lock") ? "uv" : ctx.exists("poetry.lock") ? "poetry" : ctx.exists("Pipfile") ? "pipenv" : "pip";
    evidence.push(`tooling: ${tool}`);

    let python: string[];
    let install: CommandSpec[] | undefined;
    const existingVenv = venvPython(ctx);
    const sysPython = isWindows ? "python" : "python3";

    if (tool === "uv") {
      python = ["uv", "run", "python"];
      install = [cmd("uv", "sync")];
    } else if (tool === "poetry") {
      python = ["poetry", "run", "python"];
      install = [cmd("poetry", "install", "--no-root")];
    } else if (tool === "pipenv") {
      python = ["pipenv", "run", "python"];
      install = [cmd("pipenv", "install")];
    } else if (!markers.length && !existingVenv) {
      // A lone script with no dependency manifest: use the system interpreter.
      python = [sysPython];
    } else {
      // Never pip-install into the system interpreter: use (or create) a project venv.
      // Dependency install runs every time; pip is a fast no-op when satisfied,
      // and it repairs a venv left half-built by an interrupted run.
      const venvPy = existingVenv ?? (isWindows ? ".venv\\Scripts\\python.exe" : ".venv/bin/python");
      python = [venvPy];
      install = existingVenv ? [] : [cmd(sysPython, "-m", "venv", ".venv")];
      if (existingVenv) evidence.push(`virtualenv: ${existingVenv}`);
      if (ctx.exists("requirements.txt")) install.push(cmd(venvPy, "-m", "pip", "install", "--disable-pip-version-check", "-r", "requirements.txt"));
      else if (/\[build-system\]/.test(ctx.read("pyproject.toml") ?? "")) install.push(cmd(venvPy, "-m", "pip", "install", "--disable-pip-version-check", "-e", "."));
      if (!install.length) install = undefined;
    }

    const py = (...args: string[]) => cmd(python[0]!, ...python.slice(1), ...args);
    let framework: string | undefined;
    let start: CommandSpec | undefined;
    let binding: BindingStrategy = { env: { PORT: "{port}", HOST: "{host}" }, portControllable: false };
    let port = 8000;
    let confidence = 0.75;

    if (ctx.exists("manage.py") || hasDep(deps, "django")) {
      framework = "Django";
      start = py("manage.py", "runserver", "--noreload");
      binding = { args: ["{host}:{port}"], portControllable: true };
      confidence = 0.93;
      if (!ctx.exists("manage.py")) warnings.push("Django dependency found but no manage.py.");
    } else if (hasDep(deps, "fastapi")) {
      framework = "FastAPI";
      const file = ctx.grep(SOURCE_CANDIDATES, /FastAPI\s*\(/);
      const varName = file ? /(\w+)\s*=\s*FastAPI\s*\(/.exec(ctx.read(file) ?? "")?.[1] ?? "app" : "app";
      const target = `${toModule(file ?? "main.py")}:${varName}`;
      evidence.push(`ASGI app: ${target}`);
      start = py("-m", "uvicorn", target);
      binding = { args: ["--host", "{host}", "--port", "{port}"], portControllable: true };
      confidence = file ? 0.92 : 0.7;
    } else if (hasDep(deps, "streamlit")) {
      framework = "Streamlit";
      const file = ctx.grep(SOURCE_CANDIDATES, /import streamlit|from streamlit/) ?? "app.py";
      start = py("-m", "streamlit", "run", file);
      binding = { args: ["--server.address", "{host}", "--server.port", "{port}", "--server.headless", "true"], portControllable: true };
      port = 8501;
      confidence = 0.9;
    } else if (hasDep(deps, "gradio")) {
      framework = "Gradio";
      const file = ctx.grep(SOURCE_CANDIDATES, /import gradio|from gradio/) ?? "app.py";
      start = py(file);
      binding = { env: { GRADIO_SERVER_NAME: "{host}", GRADIO_SERVER_PORT: "{port}" }, portControllable: true };
      port = 7860;
      confidence = 0.88;
    } else if (hasDep(deps, "flask")) {
      framework = "Flask";
      const file = ctx.grep(SOURCE_CANDIDATES, /Flask\s*\(/) ?? "app.py";
      start = py("-m", "flask", "--app", toModule(file), "run");
      binding = { args: ["--host", "{host}", "--port", "{port}"], portControllable: true };
      port = 5000;
      confidence = 0.9;
    } else if (loosePy) {
      start = py(loosePy);
      evidence.push(`entry: ${loosePy}`);
      warnings.push(`No known framework; running ${loosePy} with PORT set and discovering the port from output.`);
      confidence = 0.6;
    } else {
      warnings.push("Python project found but no entry point (main.py/app.py).");
      confidence = 0.3;
    }

    return {
      detector: "python",
      language: "python",
      runtime: "native",
      confidence,
      evidence,
      binding,
      defaultPort: port,
      ...(framework ? { framework } : {}),
      ...(start ? { start } : {}),
      ...(install ? { install } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};
