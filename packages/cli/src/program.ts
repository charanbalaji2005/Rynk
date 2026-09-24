import { Command, Option } from "commander";
import { VERSION } from "@rynk/core";
import * as acc from "./commands/access.js";
import { doctor } from "./commands/doctor.js";
import * as m from "./commands/manage.js";
import * as n from "./commands/net.js";
import { up, type UpOptions } from "./run.js";
import { printError } from "./ui.js";

type Handler<A extends unknown[]> = (...args: A) => Promise<number>;

/** Wrap a command so errors print the friendly way and set the exit code. */
function action<A extends unknown[]>(fn: Handler<A>) {
  return async (...args: A) => {
    const cmd = args[args.length - 1] as Command;
    const opts = { ...cmd.optsWithGlobals() } as { json?: boolean; verbose?: boolean };
    try {
      process.exitCode = await fn(...args);
    } catch (e) {
      printError(e, { json: Boolean(opts.json), verbose: Boolean(opts.verbose) });
      process.exitCode = 1;
    }
    // Commands resolve only when done (foreground/follow included), so exit promptly.
    setTimeout(() => process.exit(process.exitCode), 50).unref();
  };
}

function hostingOptions(cmd: Command): Command {
  return cmd
    .option("--lan", "share with devices on this network (default)")
    .option("--local", "keep it on this computer only")
    .option("--public", "also create a public internet link (explicit opt-in)")
    .option("-p, --port <port>", "port people connect to (default: auto)")
    .option("--host <host>", "address to listen on: auto, 0.0.0.0, 127.0.0.1 or an interface IP")
    .option("--network <name|ip>", "network interface whose IP goes in the share link")
    .option("--cmd <command>", "start command to run instead of the detected one")
    .addOption(new Option("--runtime <runtime>", "force a runtime").choices(["auto", "native", "docker", "compose", "static", "custom"]))
    .option("-n, --name <name>", "project name")
    .option("--max-users <n>", "maximum active users (0 = unlimited)")
    .option("--protected", "invite-only link (share invites with `rynk share --invite`)")
    .option("--no-advertise", "don't announce this app to other Rynk nodes")
    .option("--no-restart", "don't restart the app if it crashes")
    .option("--no-health-check", "don't probe HTTP; only watch the process")
    .option("--no-install", "skip dependency installation")
    .option("-e, --env <KEY=value...>", "extra environment variables")
    .option("--qr", "print a QR code for the share link")
    .option("-y, --yes", "accept detected settings without the popup")
    .option("--non-interactive", "no popup, no questions (automation/CI)")
    .option("--popup", "always show the configuration popup")
    .option("--no-popup", "never show the configuration popup");
}

export function buildProgram(): Command {
  const program = new Command("rynk")
    .description("Run one command. Rynk configures your project, hosts it on your machine,\ngives you a live link, and lets you control who can access it.")
    .version(VERSION, "-v, --version")
    .option("--json", "machine-readable output")
    .option("--verbose", "show full output and raw errors")
    .showSuggestionAfterError()
    .configureHelp({ sortSubcommands: false });

  const hostAction = (mode: "foreground" | "detached") =>
    action(async (dir: string, o: UpOptions) => up(dir, { ...o, ...program.opts() }, o.nonInteractive && mode === "foreground" ? "detached" : mode));

  hostingOptions(program.argument("[dir]", "project directory", ".")).action(hostAction("foreground"));

  hostingOptions(program.command("start").description("host in the background (the daemon keeps it running)").argument("[dir]", "project directory", "."))
    .action(hostAction("detached"));
  hostingOptions(program.command("dev").description("host in the foreground; Ctrl+C stops it").argument("[dir]", "project directory", "."))
    .action(hostAction("foreground"));

  program.command("stop").description("stop hosting (default: this directory)").argument("[project]").option("-a, --all", "stop everything")
    .action(action(async (ref: string | undefined, o: { all?: boolean }) => m.stop(ref, { ...o, ...program.opts() })));
  program.command("restart").description("restart the app in place (same link, clients keep their sessions)").argument("[project]")
    .action(action(async (ref: string | undefined) => m.restart(ref, program.opts())));
  program.command("status").description("status, share link and users").argument("[project]").option("-a, --all", "all projects")
    .action(action(async (ref: string | undefined, o: { all?: boolean }) => m.status(ref, { ...o, ...program.opts() })));
  program.command("logs").description("show logs").argument("[project]").option("-f, --follow", "stream new lines").option("-n, --lines <n>", "number of lines", "200").option("--tail <n>", "same as --lines").option("--since <duration>", "only lines from the last 30m, 2h, 1d…")
    .action(action(async (ref: string | undefined, o: { follow?: boolean; lines?: string; tail?: string; since?: string }) => m.logs(ref, { ...o, ...program.opts() })));

  program.command("share").description("show the share link + QR; create invites or a public link").argument("[project]")
    .option("--invite", "create an invite link (makes the app invite-only)")
    .option("--expires <duration>", "invite lifetime, e.g. 30m, 2h", "1h")
    .option("--uses <n>", "how many people can use the invite", "10")
    .option("--revoke <inviteId>", "revoke an invite")
    .option("--public", "create an internet-reachable link (opt-in)")
    .option("--provider <name>", "public provider (cloudflare)")
    .option("--stop", "close the public link")
    .option("--open", "open the link in your browser")
    .option("--copy", "copy the link to the clipboard")
    .option("--qr", "print a QR code (default)")
    .option("--no-qr", "don't print a QR code")
    .option("-y, --yes", "skip the confirmation for --public")
    .action(action(async (ref: string | undefined, o: acc.ShareOptions) => acc.share(ref, { ...o, ...program.opts() })));

  program.command("clients").description("who is connected; `clients disconnect <session> [--block]`").argument("[project|disconnect|unblock]").argument("[session|address]")
    .option("--block", "also block the client's address until hosting stops")
    .option("--project <name>", "project (for disconnect/unblock)")
    .action(action(async (a: string | undefined, b: string | undefined, o: { block?: boolean; project?: string }) => {
      const opts = { ...o, ...program.opts() };
      if (a === "disconnect") return acc.disconnect(b ?? "", opts);
      if (a === "unblock") return acc.unblock(b ?? "", opts);
      return acc.clients(a, program.opts());
    }));

  program.command("limit").description("set the maximum number of active users (0 = unlimited)").argument("<n>").argument("[project]")
    .action(action(async (value: string, ref: string | undefined) => acc.limit(value, ref, program.opts())));

  program.command("apps").description("apps shared by every Rynk node on this network")
    .action(action(async () => n.apps(program.opts())));
  program.command("nodes").alias("devices").description("Rynk computers on this network")
    .action(action(async () => n.nodes(program.opts())));
  program.command("network").description("interfaces, IP and discovery; `network test` checks everything").argument("[action]", "test")
    .action(action(async (a: string | undefined) => (a === "test" ? n.networkTest(program.opts()) : n.network(program.opts()))));
  program.command("ports").description("ports Rynk is using")
    .action(action(async () => n.ports(program.opts())));
  program.command("hosting").description("hosting sessions: when each project was shared, peak users, outcome").argument("[project]").option("-a, --all", "full history")
    .action(action(async (ref: string | undefined, o: { all?: boolean }) => m.hosting(ref, { ...o, ...program.opts() })));
  program.command("inspect").description("everything Rynk knows about a project").argument("[project]")
    .action(action(async (ref: string | undefined) => n.inspect(ref, program.opts())));
  program.command("plan").description("show what Rynk would do here, without doing it").argument("[dir]", "project directory", ".")
    .option("--runtime <runtime>").option("--cmd <command>").option("-p, --port <port>").option("-n, --name <name>").option("--network <name|ip>").option("--local").option("--max-users <n>")
    .action(action(async (dir: string, o: Record<string, string | boolean>) => n.plan(dir, Object.assign({}, o, program.opts()) as never)));
  program.command("doctor").description("diagnose runtime, network and project problems").argument("[dir]", "project directory", ".")
    .action(action(async (dir: string) => doctor(dir, program.opts())));

  program.command("routes").description("name routes (http://<name>.localhost:7777)")
    .action(action(async () => m.routes(program.opts())));
  program.command("projects").alias("ls").description("projects Rynk knows")
    .action(action(async () => m.projects(program.opts())));
  program.command("remove").alias("rm").description("forget a project (stops it; files untouched)").argument("[project]")
    .action(action(async (ref: string | undefined) => m.remove(ref, program.opts())));
  program.command("init").description("write a rynk.yaml with the detected settings (optional)").argument("[dir]", "project directory", ".").option("-f, --force", "overwrite an existing file")
    .action(action(async (dir: string, o: { force?: boolean }) => m.init(dir, { ...o, ...program.opts() })));
  hostingOptions(program.command("deploy").description("host a directory or git repository (github:user/repo)").argument("[source]", "path or git URL"))
    .option("--device <device>", "target device (local)")
    .action(action(async (source: string | undefined, o: UpOptions & { device?: string }) => m.deploy(source, { ...o, ...program.opts() })));
  program.command("runtime").description("runtimes available on this computer")
    .action(action(async () => m.runtime(program.opts())));
  program.command("daemon").description("manage the background daemon").argument("<action>", "start | stop | restart | status | logs")
    .action(action(async (a: string) => m.daemon(a, program.opts())));

  return program;
}
