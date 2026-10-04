#!/usr/bin/env python3
"""_ppapi.py - the small HTTP and token layer shared by fabric.py, deploy-flows.py, seed-data.py,
reconcile-report.py and pbi-theme.py. Not a command; imported from the same folder.

    from _ppapi import get_token, Client, ApiError

Tokens, in order: the --token-env variable, --token-cmd ("{resource}" and "{org}" are replaced),
`az account get-access-token --resource <resource>`, then Az PowerShell `Get-AzAccessToken`. A
token is never printed or written.

Client is a JSON REST client with retries (429, 502-504), paging (@odata.nextLink and Fabric's
continuationUri), long-running operations (202 + Location) and a structural read-only mode: with
read_only=True anything but GET is refused unless the call is marked read=True (a POST that only
reads, such as Power BI executeQueries). Every selftest swaps the transport for a fake, so no test
ever opens a socket.

Python 3 standard library only.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

RESOURCES = {
    "fabric": "https://api.fabric.microsoft.com",
    "powerbi": "https://analysis.windows.net/powerbi/api",
    "flow": "https://service.flow.microsoft.com/",
    "powerapps": "https://service.powerapps.com/",
}
FORMATTED = "@OData.Community.Display.V1.FormattedValue"


class ApiError(Exception):
    pass


class NotFound(ApiError):
    pass


class PlanRefused(RuntimeError):
    """A write was attempted in plan mode. Always a bug in the caller, never a server answer."""


def _run(cmd, shell=False, timeout=120):
    r = subprocess.run(cmd, capture_output=True, shell=shell, timeout=timeout)
    return r.returncode, r.stdout.decode("utf-8", "replace").strip(), r.stderr.decode("utf-8", "replace").strip()


def get_token(resource, token_cmd=None, token_env=None, org=None):
    """(token, how). Raises ApiError naming everything it tried."""
    if token_env and os.environ.get(token_env):
        return os.environ[token_env].strip(), "environment variable %s" % token_env
    if token_cmd:
        cmd = token_cmd.replace("{resource}", resource).replace("{org}", org or resource)
        rc, out, err = _run(cmd, shell=True)
        if rc == 0 and out:
            return out.splitlines()[-1].strip(), "--token-cmd"
        raise ApiError("--token-cmd failed (exit %d): %s" % (rc, err[-300:]))
    tried = []
    az = shutil.which("az")
    if az:
        rc, out, err = _run([az, "account", "get-access-token", "--resource", resource,
                             "--query", "accessToken", "-o", "tsv"])
        if rc == 0 and out:
            return out.splitlines()[-1].strip(), "az account get-access-token"
        tried.append("az (exit %d: %s)" % (rc, err[-200:]))
    else:
        tried.append("az (not on PATH)")
    ps = shutil.which("pwsh") or shutil.which("powershell")
    if ps:
        script = ("$ErrorActionPreference='Stop'; $t=(Get-AzAccessToken -ResourceUrl '%s').Token; "
                  "if ($t -is [securestring]) { [System.Net.NetworkCredential]::new('', $t).Password } "
                  "else { $t }" % resource)
        rc, out, err = _run([ps, "-NoProfile", "-NonInteractive", "-Command", script])
        if rc == 0 and out:
            return out.splitlines()[-1].strip(), "Az PowerShell Get-AzAccessToken"
        tried.append("Az PowerShell (exit %d)" % rc)
    raise ApiError("no access token for %s: tried %s. Sign in (az login / Connect-AzAccount), or pass "
                   "--token-cmd, or set %s" % (resource, "; ".join(tried), token_env or "a token variable"))


def urllib_transport(method, url, body, headers, timeout=120):
    """(status, headers{lower: value}, parsed body or None). Never raises on an HTTP status."""
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            hdrs = {k.lower(): v for k, v in r.headers.items()}
            status = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        hdrs = {k.lower(): v for k, v in (e.headers or {}).items()}
        status = e.code
    try:
        parsed = json.loads(raw) if raw.strip() else None
    except ValueError:
        parsed = {"_text": raw[:2000]}
    return status, hdrs, parsed


class Client:
    """JSON REST client. base is prefixed to relative paths; absolute URLs pass through."""

    def __init__(self, base, token, read_only=True, transport=None, sleep=None, extra_headers=None):
        self.base = base.rstrip("/") + "/"
        self.token = token
        self.read_only = read_only
        self.transport = transport or urllib_transport
        self.sleep = sleep or time.sleep
        self.extra = extra_headers or {}
        self.calls = []                    # (method, short path): the summary and the selftests read it

    def url(self, path):
        u = path if path.startswith("http") else self.base + path.lstrip("/")
        return urllib.parse.quote(u, safe=":/?&=$,()'@.%-_~*+;!")

    def call(self, method, path, body=None, headers=None, read=False, ok404=False):
        """(status, headers, body). Raises ApiError on 4xx/5xx after retries; PlanRefused in plan mode."""
        if self.read_only and method != "GET" and not read:
            raise PlanRefused("plan mode refused %s %s - a plan never writes" % (method, path))
        h = {"Authorization": "Bearer " + self.token, "Accept": "application/json"}
        h.update(self.extra)
        if body is not None:
            h["Content-Type"] = "application/json; charset=utf-8"
        h.update(headers or {})
        url = self.url(path)
        short = url.replace(self.base, "")
        last = None
        for attempt in range(1, 6):
            self.calls.append((method, short))
            try:
                status, hdrs, out = self.transport(method, url, body, h)
            except (urllib.error.URLError, OSError) as e:
                last = str(e)
                self.sleep(2 ** attempt)
                continue
            if status < 400:
                return status, hdrs, out
            msg = _message(out)
            if status == 404 and ok404:
                return status, hdrs, None
            if status == 404:
                raise NotFound("%s %s: %s" % (method, short, msg))
            if status in (429, 502, 503, 504) and attempt < 5:
                self.sleep(float(hdrs.get("retry-after") or 3 * attempt))
                last = "HTTP %d %s" % (status, msg)
                continue
            if status in (401, 403):
                raise ApiError("HTTP %d on %s %s - the token is not valid here or the account lacks the "
                               "permission: %s" % (status, method, short, msg))
            raise ApiError("%s %s failed: HTTP %d %s" % (method, short, status, msg))
        raise ApiError("%s %s gave up after retries: %s" % (method, short, last))

    def get(self, path, **kw):
        return self.call("GET", path, **kw)[2]

    def get_all(self, path):
        """Every row of a paged collection ('value'), following nextLink / continuationUri."""
        rows, url = [], path
        while url:
            body = self.get(url) or {}
            rows.extend(body.get("value") or body.get("data") or [])
            url = body.get("@odata.nextLink") or body.get("continuationUri")
        return rows

    def wait_operation(self, hdrs, timeout_s=900, poll_s=None):
        """Follow a 202 long-running operation (Location header) to its end; return its result or None."""
        loc = hdrs.get("location")
        start = time.time()
        while loc:
            self.sleep(float(poll_s or hdrs.get("retry-after") or 3))
            status, hdrs2, body = self.call("GET", loc, read=True)
            st = (body or {}).get("status")
            if st in ("Failed", "Cancelled"):
                raise ApiError("operation %s: %s" % (st, json.dumps((body or {}).get("error") or body)[:1500]))
            if st in ("Succeeded", "Completed") or (st is None and status == 200):
                try:
                    return self.call("GET", loc.rstrip("/") + "/result", read=True, ok404=True)[2]
                except ApiError:
                    return body
            if time.time() - start > timeout_s:
                raise ApiError("operation still %s after %d s: %s" % (st, timeout_s, loc))
            hdrs = hdrs2 or hdrs
        return None


def _message(out):
    if isinstance(out, dict):
        err = out.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err.get("code") or err)[:600]
        for k in ("message", "errorCode", "_text"):
            if out.get(k):
                return str(out[k])[:600]
    return json.dumps(out)[:600] if out is not None else ""


def odata_literal(value):
    """A string literal for $filter: apostrophes doubled; URL encoding happens on send."""
    return "'%s'" % str(value).replace("'", "''")


def dataverse(org, token, read_only=True, transport=None, sleep=None):
    """A Client on <org>/api/data/v9.2/ with the OData headers and formatted values."""
    return Client(org.rstrip("/") + "/api/data/v9.2/", token, read_only, transport, sleep,
                  {"OData-MaxVersion": "4.0", "OData-Version": "4.0",
                   "Prefer": 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"'})


class FakeTransport:
    """For selftests: routes (method, url) to handler functions; records every call."""

    def __init__(self):
        self.routes = []
        self.calls = []
        self.headers = []                  # request headers, parallel to calls

    def on(self, method, needle, fn):
        """fn(url, body) -> (status, headers, body), or a plain body for 200."""
        self.routes.append((method, needle, fn))
        return self

    def __call__(self, method, url, body, headers, timeout=None):
        self.calls.append((method, urllib.parse.unquote(url), body))
        self.headers.append(dict(headers))
        u = urllib.parse.unquote(url)
        for m, needle, fn in reversed(self.routes):
            if m == method and needle in u:
                r = fn(u, body)
                return r if isinstance(r, tuple) else (200, {}, r)
        return 404, {}, {"error": {"message": "no fake route for %s %s" % (method, u)}}

    def writes(self):
        return [(m, u) for m, u, _ in self.calls if m != "GET"]
