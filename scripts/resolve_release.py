"""Resolve a published stable FolderFrame release to an immutable commit."""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

REPO = "The-Grog/FolderFrame"

def api(path):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "FolderFrame-Deployment"}
    if os.environ.get("GH_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    with urllib.request.urlopen(urllib.request.Request(
        "https://api.github.com/repos/" + REPO + path, headers=headers), timeout=30) as response:
        return json.load(response)

def resolve(fetch=api):
    try:
        release = fetch("/releases/latest")
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        fetch("")  # Confirm repo access; do not hide missing repo/auth failures.
        return None
    if release.get("draft") or release.get("prerelease"):
        raise ValueError("Only published stable releases may be packaged")
    tag = release["tag_name"]
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}", tag):
        raise ValueError("Release tag must be a Docker-compatible version, e.g. v0.1.0")
    sha = fetch("/commits/" + urllib.parse.quote(tag, safe=""))["sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Expected immutable commit SHA")
    return {"tag": tag, "sha": sha}

if __name__ == "__main__":
    result = resolve()
    lines = ["available=false"] if result is None else [
        "available=true", "tag=" + result["tag"], "sha=" + result["sha"]]
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write("\n".join(lines) + "\n")
    print("No stable release yet; nothing will be published." if result is None else json.dumps(result))
