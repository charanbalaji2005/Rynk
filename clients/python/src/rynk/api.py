"""High-level Python API: ``from rynk import Rynk``."""

from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .client import DaemonState, RynkClient, RynkError
from .launcher import node_cli


class HostedApp:
    """A project hosted through :meth:`Rynk.host`."""

    def __init__(self, rynk: "Rynk", project_id: str, deployment: Dict[str, Any]):
        self._rynk = rynk
        self.project_id = project_id
        self.deployment = deployment

    @property
    def urls(self) -> Dict[str, str]:
        return self.deployment.get("urls") or {}

    @property
    def url(self) -> Optional[str]:
        u = self.urls
        return u.get("public") or u.get("network") or u.get("local")

    @property
    def port(self) -> Optional[int]:
        return self.deployment.get("port")

    def stop(self) -> Dict[str, Any]:
        return self._rynk.stop(self.project_id)

    def restart(self) -> Dict[str, Any]:
        return self._rynk._c.request("POST", "/api/projects/%s/restart" % RynkClient.q(self.project_id), {})

    def clients(self) -> List[Dict[str, Any]]:
        return self._rynk.clients(self.project_id)["sessions"]

    def set_limit(self, max_users: int) -> Dict[str, Any]:
        return self._rynk._c.request("PATCH", "/api/projects/%s/access" % RynkClient.q(self.project_id), {"maxUsers": max_users})

    def invite(self, ttl_ms: int = 3_600_000, max_uses: int = 10) -> Dict[str, Any]:
        return self._rynk._c.request("POST", "/api/projects/%s/invites" % RynkClient.q(self.project_id), {"ttlMs": ttl_ms, "maxUses": max_uses})

    def disconnect(self, session_id: str, block: bool = False) -> Dict[str, Any]:
        return self._rynk._c.request("POST", "/api/projects/%s/clients/%s/disconnect" % (RynkClient.q(self.project_id), RynkClient.q(session_id)), {"block": block})


class Rynk:
    """Programmatic access to Rynk. The CLI stays the primary interface."""

    def __init__(self, client: RynkClient):
        self._c = client

    @classmethod
    def connect(cls, start_daemon: bool = True, timeout: float = 20.0) -> "Rynk":
        state = DaemonState.load()
        if state:
            try:
                c = RynkClient(state, timeout=2)
                c.request("GET", "/api/health")
                return cls(RynkClient(state))
            except RynkError:
                pass
        if not start_daemon:
            raise RynkError("DAEMON_UNREACHABLE", "The Rynk daemon isn't running.", suggestions=["rynk daemon start"])
        subprocess.run([*node_cli(), "daemon", "start"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + timeout
        while time.time() < deadline:
            state = DaemonState.load()
            if state:
                try:
                    RynkClient(state, timeout=2).request("GET", "/api/health")
                    return cls(RynkClient(state))
                except RynkError:
                    pass
            time.sleep(0.2)
        raise RynkError("DAEMON_UNREACHABLE", "The Rynk daemon did not start.", suggestions=["rynk doctor"])

    def host(self, path: str = ".", *, wait: bool = True, max_users: Optional[int] = None, protected: bool = False,
             port: Optional[int] = None, local: bool = False, command: Optional[str] = None, name: Optional[str] = None,
             network: Optional[str] = None, env: Optional[Dict[str, str]] = None) -> HostedApp:
        body: Dict[str, Any] = {"root": str(Path(path).resolve()), "wait": wait, "foreground": False}
        for key, val in (("maxUsers", max_users), ("port", port), ("command", command), ("name", name), ("network", network), ("env", env)):
            if val is not None:
                body[key] = val
        if protected:
            body["protected"] = True
        if local:
            body["exposure"] = "local"
        res = self._c.request("POST", "/api/deployments", body, timeout=900)
        if res.get("ok") is False and res.get("error"):
            e = res["error"]
            raise RynkError(e.get("code", "INTERNAL"), e.get("message", ""), e.get("causes"), e.get("suggestions"))
        dep = res.get("deployment") or self._c.request("GET", "/api/deployments/%s" % res["deploymentId"])
        return HostedApp(self, res["projectId"], dep)

    def status(self, project: str) -> Dict[str, Any]:
        return self._c.request("GET", "/api/projects/%s" % RynkClient.q(project))

    def projects(self) -> List[Dict[str, Any]]:
        return self._c.request("GET", "/api/projects")

    def stop(self, project: str) -> Dict[str, Any]:
        return self._c.request("POST", "/api/projects/%s/stop" % RynkClient.q(project), {}, timeout=30)

    def clients(self, project: str) -> Dict[str, Any]:
        return self._c.request("GET", "/api/projects/%s/clients" % RynkClient.q(project))

    def plan(self, path: str = ".") -> Dict[str, Any]:
        return self._c.request("GET", "/api/plan?root=%s" % RynkClient.q(str(Path(path).resolve())))

    def apps(self) -> List[Dict[str, Any]]:
        try:
            self._c.request("POST", "/api/nodes/refresh", {}, timeout=10)
        except RynkError:
            pass
        return self._c.request("GET", "/api/apps")

    def nodes(self) -> List[Dict[str, Any]]:
        return self._c.request("POST", "/api/nodes/refresh", {}, timeout=10)

    def network(self) -> Dict[str, Any]:
        return self._c.request("GET", "/api/network")
