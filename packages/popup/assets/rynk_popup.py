#!/usr/bin/env python3
"""
Rynk "Host this project" popup.

A small native window (Tk) launched by the Rynk CLI. It talks to the CLI over
stdin/stdout using JSON lines and never touches the network or the daemon
token itself. Closing it never stops hosting; only "Stop Hosting" does.

Messages in (CLI -> popup):  init, progress, failed, live, status, qr, log, stopped, close
Messages out (popup -> CLI): ready, start, cancel, action, disconnect, limit, closed
"""
import json
import queue
import sys
import threading
import time
import webbrowser

import tkinter as tk
from tkinter import ttk

OUT_LOCK = threading.Lock()


def send(msg):
    with OUT_LOCK:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def reader(q):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            q.put(json.loads(line))
        except ValueError:
            pass
    q.put({"type": "close"})


def fmt_uptime(ms):
    s = int(ms // 1000)
    return "%02d:%02d:%02d" % (s // 3600, (s % 3600) // 60, s % 60)


def fmt_since(ts_ms):
    return time.strftime("%H:%M", time.localtime(ts_ms / 1000))


class Popup:
    PAD = 14

    def __init__(self, root, inbox):
        self.root = root
        self.inbox = inbox
        self.mode = "waiting"  # waiting | config | progress | live | failed | stopped
        self.init = {}
        self.live = {}
        self.started_at = None
        self.logs_visible = False
        self.qr_window = None

        root.title("Rynk")
        root.resizable(False, False)
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.bind("<Escape>", lambda e: self.on_close())

        style = ttk.Style(root)
        if sys.platform.startswith("linux") and "clam" in style.theme_names():
            style.theme_use("clam")
        base = ("TkDefaultFont",)
        style.configure("Title.TLabel", font=(base[0], 15, "bold"))
        style.configure("Big.TLabel", font=(base[0], 13, "bold"))
        style.configure("Muted.TLabel", foreground="#5b6770")
        style.configure("Live.TLabel", foreground="#12825a", font=(base[0], 11, "bold"))
        style.configure("Warn.TLabel", foreground="#9a5b00")
        style.configure("Error.TLabel", foreground="#b3261e")
        style.configure("Link.TEntry")

        self.frame = ttk.Frame(root, padding=self.PAD)
        self.frame.grid(sticky="nsew")
        ttk.Label(self.frame, text="Detecting project…", style="Muted.TLabel").grid()
        root.after(40, self.pump)
        root.after(1000, self.tick)

    # ── plumbing ───────────────────────────────────────────
    def clear(self):
        for w in self.frame.winfo_children():
            w.destroy()

    def pump(self):
        try:
            while True:
                self.handle(self.inbox.get_nowait())
        except queue.Empty:
            pass
        self.root.after(40, self.pump)

    def handle(self, m):
        t = m.get("type")
        if t == "init":
            self.init = m
            self.show_config()
        elif t == "progress" and self.mode in ("progress", "config"):
            if self.mode != "progress":
                self.show_progress()
            self.progress_line(m.get("text", ""))
        elif t == "failed":
            self.show_failed(m)
        elif t == "live":
            self.live = m
            self.started_at = time.time() - (m.get("uptimeMs") or 0) / 1000
            self.show_live()
        elif t == "status" and self.mode == "live":
            self.update_status(m)
        elif t == "qr":
            self.show_qr(m)
        elif t == "log":
            self.append_log(m.get("line", ""))
        elif t == "stopped":
            self.show_stopped(m.get("message", "Hosting stopped."))
        elif t == "close":
            self.root.destroy()

    def on_close(self):
        if self.mode == "config":
            send({"type": "cancel"})
        else:
            send({"type": "closed"})
        self.root.destroy()

    def tick(self):
        if self.mode == "live" and self.started_at and hasattr(self, "uptime_var"):
            self.uptime_var.set(fmt_uptime((time.time() - self.started_at) * 1000))
        self.root.after(1000, self.tick)

    def row(self, parent, r, label, widget):
        ttk.Label(parent, text=label, style="Muted.TLabel").grid(row=r, column=0, sticky="w", pady=3, padx=(0, 12))
        widget.grid(row=r, column=1, sticky="ew", pady=3)

    # ── configuration view ─────────────────────────────────
    def show_config(self):
        self.mode = "config"
        self.clear()
        f = self.frame
        p = self.init.get("project", {})
        d = self.init.get("defaults", {})
        net = self.init.get("network", {})
        f.columnconfigure(0, weight=1)

        head = ttk.Frame(f)
        head.grid(sticky="ew")
        head.columnconfigure(0, weight=1)
        ttk.Label(head, text="Host with Rynk", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(head, text="● Ready", style="Live.TLabel").grid(row=0, column=1, sticky="e")

        proj = ttk.Frame(f, padding=(0, 10, 0, 4))
        proj.grid(sticky="ew")
        ttk.Label(proj, text=p.get("name", "project"), style="Big.TLabel").grid(sticky="w")
        stack = " · ".join(x for x in [p.get("framework"), p.get("runtimeLabel"), p.get("packageManager")] if x)
        ttk.Label(proj, text=stack or "Custom project", style="Muted.TLabel").grid(sticky="w")
        ttk.Label(proj, text=p.get("root", ""), style="Muted.TLabel", wraplength=380).grid(sticky="w")

        ttk.Separator(f).grid(sticky="ew", pady=8)
        form = ttk.Frame(f)
        form.grid(sticky="ew")
        form.columnconfigure(1, weight=1)

        self.v_name = tk.StringVar(value=d.get("name") or p.get("name", ""))
        self.v_cmd = tk.StringVar(value=d.get("command") or p.get("command", ""))
        self.v_runtime = tk.StringVar(value=d.get("runtime", "Auto"))
        self.v_port = tk.StringVar(value=str(d.get("port", "Auto")))
        self.v_host = tk.StringVar(value=d.get("host", "Auto"))
        self.v_exposure = tk.StringVar(value=d.get("exposure", "lan"))
        self.v_max = tk.StringVar(value=str(d.get("maxUsers", 0)))
        self.v_protected = tk.BooleanVar(value=bool(d.get("protected", False)))
        self.v_restart = tk.BooleanVar(value=bool(d.get("autoRestart", True)))
        self.v_health = tk.BooleanVar(value=bool(d.get("healthCheck", True)))
        self.v_adv = tk.BooleanVar(value=bool(d.get("advertise", True)))
        ifaces = net.get("interfaces", [])
        self.v_iface = tk.StringVar(value=net.get("selected") or (ifaces[0]["address"] if ifaces else ""))

        r = 0
        self.row(form, r, "Project name", ttk.Entry(form, textvariable=self.v_name, width=30)); r += 1
        self.row(form, r, "Start command", ttk.Entry(form, textvariable=self.v_cmd, width=30)); r += 1
        self.row(form, r, "Runtime", ttk.Combobox(form, textvariable=self.v_runtime, values=self.init.get("options", {}).get("runtimes", ["Auto"]), state="readonly", width=28)); r += 1
        port_values = ["Auto"] + [str(x) for x in self.init.get("options", {}).get("ports", [3000, 5173, 8000, 8080])]
        self.row(form, r, "Port", ttk.Combobox(form, textvariable=self.v_port, values=port_values, width=28)); r += 1
        host_values = ["Auto", "0.0.0.0", "127.0.0.1"] + [i["address"] for i in ifaces]
        self.row(form, r, "Host", ttk.Combobox(form, textvariable=self.v_host, values=host_values, width=28)); r += 1

        ttk.Label(form, text="Network", style="Muted.TLabel").grid(row=r, column=0, sticky="nw", pady=3)
        nets = ttk.Frame(form)
        nets.grid(row=r, column=1, sticky="w", pady=3)
        if not ifaces:
            ttk.Label(nets, text="No network found; this machine only", style="Warn.TLabel").grid(sticky="w")
        for i, iface in enumerate(ifaces[:6]):
            label = "%s   %s%s" % (iface.get("label") or iface["name"], iface["address"], "   (auto)" if i == 0 else "")
            ttk.Radiobutton(nets, text=label, value=iface["address"], variable=self.v_iface).grid(sticky="w")
        r += 1

        ttk.Label(form, text="Exposure", style="Muted.TLabel").grid(row=r, column=0, sticky="nw", pady=3)
        exp = ttk.Frame(form)
        exp.grid(row=r, column=1, sticky="w", pady=3)
        for val, text in (("local", "Local only (this computer)"), ("lan", "LAN (devices on this network)"), ("public", "Public tunnel (internet)")):
            ttk.Radiobutton(exp, text=text, value=val, variable=self.v_exposure).grid(sticky="w")
        self.public_warn = ttk.Label(exp, text="Anyone with the link can open it.", style="Warn.TLabel")
        r += 1

        box = ttk.Frame(form)
        ttk.Spinbox(box, from_=0, to=10000, textvariable=self.v_max, width=8).grid(row=0, column=0)
        ttk.Label(box, text="  0 = unlimited", style="Muted.TLabel").grid(row=0, column=1)
        self.row(form, r, "Max active users", box); r += 1

        checks = ttk.Frame(form)
        for i, (var, text) in enumerate(((self.v_protected, "Invite-only link"), (self.v_restart, "Auto restart"), (self.v_health, "Health check"), (self.v_adv, "Network discovery"))):
            ttk.Checkbutton(checks, text=text, variable=var).grid(row=i // 2, column=i % 2, sticky="w", padx=(0, 16))
        self.row(form, r, "Options", checks); r += 1

        ttk.Separator(f).grid(sticky="ew", pady=8)
        self.v_summary = tk.StringVar()
        ttk.Label(f, textvariable=self.v_summary, style="Muted.TLabel", wraplength=400, justify="left").grid(sticky="w")

        btns = ttk.Frame(f, padding=(0, 12, 0, 0))
        btns.grid(sticky="e")
        ttk.Button(btns, text="Cancel", command=self.on_close).grid(row=0, column=0, padx=(0, 8))
        start = ttk.Button(btns, text="Start Hosting", command=self.start, default="active")
        start.grid(row=0, column=1)
        self.root.bind("<Return>", lambda e: self.start())
        start.focus_set()

        for v in (self.v_port, self.v_exposure, self.v_iface, self.v_max, self.v_protected, self.v_host):
            v.trace_add("write", lambda *a: self.refresh_summary())
        self.refresh_summary()
        # Test hook: lets integration tests exercise "Start Hosting" headlessly.
        import os
        if os.environ.get("RYNK_POPUP_AUTOSTART"):
            self.root.after(int(os.environ["RYNK_POPUP_AUTOSTART"]), self.start)

    def refresh_summary(self):
        port = self.v_port.get().strip()
        if not port.isdigit():
            port = str(self.init.get("sharePort") or "auto")
        exp = self.v_exposure.get()
        host = "localhost" if exp == "local" else (self.v_iface.get() or "localhost")
        try:
            limit = int(self.v_max.get() or 0)
        except ValueError:
            limit = 0
        parts = ["Share link: http://%s:%s" % (host, port), "Access: %s%s" % ({"local": "this computer", "lan": "LAN", "public": "LAN + public tunnel"}[exp], ", invite only" if self.v_protected.get() else ""), "Users: %s" % (limit or "unlimited")]
        self.v_summary.set("\n".join(parts))
        if exp == "public":
            self.public_warn.grid(sticky="w")
        else:
            self.public_warn.grid_remove()

    def start(self):
        if self.mode != "config":
            return
        port = self.v_port.get().strip()
        try:
            max_users = max(0, int(self.v_max.get() or 0))
        except ValueError:
            max_users = 0
        send({"type": "start", "settings": {
            "name": self.v_name.get().strip(),
            "command": self.v_cmd.get().strip(),
            "runtime": self.v_runtime.get(),
            "port": int(port) if port.isdigit() else None,
            "host": self.v_host.get(),
            "network": self.v_iface.get(),
            "exposure": self.v_exposure.get(),
            "maxUsers": max_users,
            "protected": self.v_protected.get(),
            "autoRestart": self.v_restart.get(),
            "healthCheck": self.v_health.get(),
            "advertise": self.v_adv.get(),
        }})
        self.root.unbind("<Return>")
        self.show_progress()

    # ── progress / failure / stopped ───────────────────────
    def show_progress(self):
        self.mode = "progress"
        self.clear()
        f = self.frame
        ttk.Label(f, text="Starting…", style="Title.TLabel").grid(sticky="w")
        ttk.Label(f, text=self.init.get("project", {}).get("name", ""), style="Muted.TLabel").grid(sticky="w", pady=(0, 8))
        self.progress_box = ttk.Frame(f)
        self.progress_box.grid(sticky="w")
        self.progress_rows = []
        bar = ttk.Progressbar(f, mode="indeterminate", length=380)
        bar.grid(sticky="ew", pady=(10, 0))
        bar.start(12)

    def progress_line(self, text):
        if not text:
            return
        for lbl in self.progress_rows:
            lbl.configure(text="✓ " + lbl.cget("text")[2:], style="TLabel")
        lbl = ttk.Label(self.progress_box, text="… " + text, style="Muted.TLabel")
        lbl.grid(sticky="w")
        self.progress_rows.append(lbl)
        self.progress_rows = self.progress_rows[-8:]

    def show_failed(self, m):
        self.mode = "failed"
        self.clear()
        f = self.frame
        ttk.Label(f, text="Couldn't start hosting", style="Title.TLabel").grid(sticky="w")
        ttk.Label(f, text=m.get("message", ""), style="Error.TLabel", wraplength=400, justify="left").grid(sticky="w", pady=(6, 6))
        for c in m.get("causes", [])[:5]:
            ttk.Label(f, text="• " + c, wraplength=400, justify="left").grid(sticky="w")
        if m.get("suggestions"):
            ttk.Label(f, text="Try:", style="Muted.TLabel").grid(sticky="w", pady=(8, 0))
            for s in m["suggestions"][:4]:
                ttk.Label(f, text="  " + s).grid(sticky="w")
        ttk.Button(f, text="Close", command=self.on_close).grid(sticky="e", pady=(12, 0))

    def show_stopped(self, message):
        self.mode = "stopped"
        self.clear()
        ttk.Label(self.frame, text="Hosting stopped", style="Title.TLabel").grid(sticky="w")
        ttk.Label(self.frame, text=message, style="Muted.TLabel").grid(sticky="w", pady=(6, 12))
        ttk.Button(self.frame, text="Close", command=self.on_close).grid(sticky="e")

    # ── live view ──────────────────────────────────────────
    def share_url(self):
        u = self.live.get("urls", {})
        return u.get("public") or u.get("network") or u.get("local") or ""

    def show_live(self):
        self.mode = "live"
        self.clear()
        f = self.frame
        f.columnconfigure(0, weight=1)
        head = ttk.Frame(f)
        head.grid(sticky="ew")
        head.columnconfigure(0, weight=1)
        ttk.Label(head, text="● LIVE", style="Live.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(head, text="Rynk", style="Muted.TLabel").grid(row=0, column=1, sticky="e")
        ttk.Label(f, text=self.live.get("name", ""), style="Title.TLabel").grid(sticky="w", pady=(4, 8))

        ttk.Label(f, text="Share link", style="Muted.TLabel").grid(sticky="w")
        self.v_link = tk.StringVar(value=self.share_url())
        link = ttk.Entry(f, textvariable=self.v_link, state="readonly", width=40, font=("TkFixedFont", 11))
        link.grid(sticky="ew", pady=(2, 6))
        acts = ttk.Frame(f)
        acts.grid(sticky="w")
        ttk.Button(acts, text="Copy link", command=self.copy).grid(row=0, column=0, padx=(0, 6))
        ttk.Button(acts, text="QR code", command=lambda: send({"type": "action", "action": "qr"})).grid(row=0, column=1, padx=(0, 6))
        ttk.Button(acts, text="Open", command=lambda: webbrowser.open(self.share_url())).grid(row=0, column=2)
        self.root.bind("<Control-c>", lambda e: self.copy())
        local = self.live.get("urls", {}).get("local")
        if local:
            ttk.Label(f, text="This computer: " + local, style="Muted.TLabel").grid(sticky="w", pady=(4, 0))

        ttk.Separator(f).grid(sticky="ew", pady=10)
        grid = ttk.Frame(f)
        grid.grid(sticky="ew")
        self.status_var = tk.StringVar(value=self.live.get("health", "HEALTHY"))
        self.uptime_var = tk.StringVar(value="00:00:00")
        self.pid_var = tk.StringVar(value=str(self.live.get("pid") or "—"))
        acc = self.live.get("access", {})
        self.users_var = tk.StringVar(value="0 / %s" % (acc.get("maxUsers") or "∞"))
        self.port_var = tk.StringVar(value=str(self.live.get("port", "")))  # keep a reference: Tk vars are GC'd otherwise
        for i, (label, var) in enumerate((("Status", self.status_var), ("Port", self.port_var), ("PID", self.pid_var), ("Uptime", self.uptime_var), ("Active users", self.users_var))):
            ttk.Label(grid, text=label, style="Muted.TLabel").grid(row=i, column=0, sticky="w", padx=(0, 16))
            ttk.Label(grid, textvariable=var).grid(row=i, column=1, sticky="w")

        ttk.Label(f, text="Connected clients", style="Muted.TLabel").grid(sticky="w", pady=(10, 2))
        self.tree = ttk.Treeview(f, columns=("addr", "status", "since"), show="headings", height=4, selectmode="browse")
        for col, text, w in (("addr", "Address", 150), ("status", "Status", 80), ("since", "Since", 70)):
            self.tree.heading(col, text=text)
            self.tree.column(col, width=w, anchor="w")
        self.tree.grid(sticky="ew")
        ctl = ttk.Frame(f)
        ctl.grid(sticky="ew", pady=(4, 0))
        ttk.Button(ctl, text="Disconnect", command=lambda: self.disconnect(False)).grid(row=0, column=0, padx=(0, 6))
        ttk.Button(ctl, text="Block", command=lambda: self.disconnect(True)).grid(row=0, column=1, padx=(0, 18))
        self.v_limit = tk.StringVar(value=str(acc.get("maxUsers", 0)))
        ttk.Label(ctl, text="Limit").grid(row=0, column=2)
        ttk.Spinbox(ctl, from_=0, to=10000, textvariable=self.v_limit, width=6).grid(row=0, column=3, padx=4)
        ttk.Button(ctl, text="Apply", command=self.apply_limit).grid(row=0, column=4)

        self.log_frame = ttk.Frame(f)
        self.log_text = tk.Text(self.log_frame, height=8, width=56, font=("TkFixedFont", 9), state="disabled", wrap="none")
        self.log_text.grid(sticky="nsew")

        ttk.Separator(f).grid(sticky="ew", pady=10)
        bottom = ttk.Frame(f)
        bottom.grid(sticky="ew")
        bottom.columnconfigure(0, weight=1)
        ttk.Button(bottom, text="Logs", command=self.toggle_logs).grid(row=0, column=0, sticky="w")
        ttk.Button(bottom, text="Restart", command=lambda: send({"type": "action", "action": "restart"})).grid(row=0, column=1, padx=6)
        ttk.Button(bottom, text="Stop Hosting", command=self.stop).grid(row=0, column=2)
        if self.live.get("warnings"):
            for w in self.live["warnings"][:3]:
                ttk.Label(f, text="⚠ " + w, style="Warn.TLabel", wraplength=400, justify="left").grid(sticky="w", pady=(6, 0))

    def update_status(self, m):
        if m.get("urls"):
            self.live["urls"] = m["urls"]
            self.v_link.set(self.share_url())
        self.status_var.set(m.get("health", self.status_var.get()))
        if m.get("pid"):
            self.pid_var.set(str(m["pid"]))
        users = m.get("users", {})
        self.users_var.set("%s / %s" % (users.get("active", 0), users.get("limit") or "∞"))
        selected = self.tree.selection()
        self.tree.delete(*self.tree.get_children())
        for c in m.get("clients", []):
            self.tree.insert("", "end", iid=c["sessionId"], values=(c["clientAddress"], c["status"].upper(), fmt_since(c["connectedAt"])))
        for s in selected:
            if self.tree.exists(s):
                self.tree.selection_set(s)

    def disconnect(self, block):
        sel = self.tree.selection()
        if sel:
            send({"type": "disconnect", "sessionId": sel[0], "block": block})

    def apply_limit(self):
        try:
            send({"type": "limit", "maxUsers": max(0, int(self.v_limit.get() or 0))})
        except ValueError:
            pass

    def copy(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.share_url())
        send({"type": "action", "action": "copy"})

    def stop(self):
        send({"type": "action", "action": "stop"})

    def toggle_logs(self):
        self.logs_visible = not self.logs_visible
        if self.logs_visible:
            self.log_frame.grid(sticky="ew", pady=(8, 0))
            send({"type": "action", "action": "logs"})
        else:
            self.log_frame.grid_remove()

    def append_log(self, line):
        if not hasattr(self, "log_text") or not self.log_text.winfo_exists():
            return
        self.log_text.configure(state="normal")
        self.log_text.insert("end", line + "\n")
        if int(self.log_text.index("end-1c").split(".")[0]) > 500:
            self.log_text.delete("1.0", "100.0")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def show_qr(self, m):
        matrix = m.get("matrix") or []
        if not matrix:
            return
        if self.qr_window and self.qr_window.winfo_exists():
            self.qr_window.destroy()
        w = tk.Toplevel(self.root)
        w.title("Scan to open")
        w.resizable(False, False)
        cell = max(4, min(8, 260 // len(matrix)))
        quiet = 4 * cell
        size = len(matrix) * cell + 2 * quiet
        c = tk.Canvas(w, width=size, height=size, bg="white", highlightthickness=0)
        c.grid(padx=10, pady=(10, 4))
        for y, row in enumerate(matrix):
            for x, bit in enumerate(row):
                if bit == "1":
                    c.create_rectangle(quiet + x * cell, quiet + y * cell, quiet + (x + 1) * cell, quiet + (y + 1) * cell, fill="black", outline="black")
        ttk.Label(w, text=m.get("url", "")).grid(pady=(0, 4))
        ttk.Label(w, text="Scan with a phone on the same network.", style="Muted.TLabel").grid(pady=(0, 10))
        w.bind("<Escape>", lambda e: w.destroy())
        self.qr_window = w


def main():
    inbox = queue.Queue()
    threading.Thread(target=reader, args=(inbox,), daemon=True).start()
    root = tk.Tk()
    Popup(root, inbox)
    root.update_idletasks()
    root.lift()
    root.attributes("-topmost", True)
    root.after(600, lambda: root.attributes("-topmost", False))
    send({"type": "ready"})
    root.mainloop()


if __name__ == "__main__":
    main()
