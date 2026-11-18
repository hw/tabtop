#!/usr/bin/env python3
"""Make TabTop's seccomp profile for Docker, for the remote browser (/go).

Docker's default seccomp profile lets a container make namespaces only with
CAP_SYS_ADMIN, so bubblewrap can't build the page engine's sandbox in it.
This profile is Docker's default with that one difference: clone, clone3,
unshare, setns, mount, umount2 and pivot_root are allowed without
CAP_SYS_ADMIN. Everything else Docker refuses, it still refuses.

Usage: generate.py DOCKER_DEFAULT_JSON > tabtop-go.json

DOCKER_DEFAULT_JSON is moby's profiles/seccomp/default.json for the Docker
version in use, e.g. https://raw.githubusercontent.com/moby/moby/v26.1.5/profiles/seccomp/default.json
(Apache-2.0, like TabTop).
"""
import json
import sys

NAMESPACE_CALLS = ["clone", "clone3", "unshare", "setns", "mount", "umount2", "pivot_root"]


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1]) as f:
        profile = json.load(f)
    kept = []
    for rule in profile["syscalls"]:
        # Drop the rules that restrict these calls for containers without
        # CAP_SYS_ADMIN; the rule added below allows them outright.
        restricted = rule.get("excludes", {}).get("caps") == ["CAP_SYS_ADMIN"]
        if restricted and set(rule["names"]) & set(NAMESPACE_CALLS):
            continue
        kept.append(rule)
    kept.append({
        "names": NAMESPACE_CALLS,
        "action": "SCMP_ACT_ALLOW",
        "comment": "TabTop /go: let bubblewrap make the page engine's sandbox without CAP_SYS_ADMIN",
    })
    profile["syscalls"] = kept
    json.dump(profile, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
