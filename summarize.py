#!/usr/bin/env python3
"""summarize.py <results_dir>

Reads the CSVs written by measure.sh and prints Markdown tables with
n, mean, standard deviation, min and max. It only reports what is in the files:
TIMEOUT / NA entries are counted and listed, never dropped silently.
"""
import csv
import math
import os
import sys
from collections import defaultdict


def rows(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def nums(rs, col):
    out, bad = [], 0
    for r in rs:
        v = (r.get(col) or "").strip()
        try:
            out.append(float(v))
        except ValueError:
            bad += 1
    return out, bad


def stat(rs, col, unit="", digits=1):
    xs, bad = nums(rs, col)
    if not xs:
        return f"no valid values ({bad} failed/NA)" if bad else "—"
    n = len(xs)
    mean = sum(xs) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in xs) / (n - 1)) if n > 1 else 0.0
    s = f"{mean:.{digits}f} ± {sd:.{digits}f} (min {min(xs):.{digits}f}, max {max(xs):.{digits}f}, n={n}){unit}"
    if bad:
        s += f"; {bad} run(s) TIMEOUT/NA"
    return s


def table(header, body):
    print("| " + " | ".join(header) + " |")
    print("|" + "|".join(["---"] * len(header)) + "|")
    for b in body:
        print("| " + " | ".join(str(x) for x in b) + " |")
    print()


def total(rs, col):
    xs, _ = nums(rs, col)
    return int(sum(xs))


def main(d):
    env = os.path.join(d, "environment.txt")
    print(f"# Measurement summary — {os.path.basename(os.path.normpath(d))}\n")
    if os.path.exists(env):
        print("Test environment is recorded in `environment.txt`.\n")

    # Footprint
    fp = rows(os.path.join(d, "footprint.csv"))
    if fp:
        by = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
        for r in fp:
            try:
                s = by[r["namespace"]][r["sample"]]
                s[0] += float(r["cpu_m"])
                s[1] += float(r["mem_mi"])
            except (ValueError, KeyError):
                pass
        print("## Resource footprint (kubectl top, 3 samples)\n")
        body = []
        for ns, samples in sorted(by.items()):
            cpu = [v[0] for v in samples.values()]
            mem = [v[1] for v in samples.values()]
            body.append([ns, f"{sum(cpu)/len(cpu):.0f}", f"{sum(mem)/len(mem):.0f}"])
        table(["Namespace", "CPU (millicores)", "Memory (MiB)"], body)

    # Recovery
    rc = rows(os.path.join(d, "recovery.csv"))
    if rc:
        print("## Pod-failure recovery\n")
        table(
            ["Metric", "Value"],
            [
                ["Runs", len(rc)],
                ["Replicas during test", ", ".join(sorted({r["replicas"] for r in rc}))],
                ["Recovery time (ms)", stat(rc, "recovery_ms", digits=0)],
                ["Failed requests in recovery window", f"{total(rc,'window_failed')} of {total(rc,'window_requests')}"],
                ["Failed requests over whole runs", f"{total(rc,'total_failed')} of {total(rc,'total_requests')}"],
            ],
        )

    # Partition
    pt = rows(os.path.join(d, "partition.csv"))
    if pt:
        passed = sum(1 for r in pt if r["result"] == "PASS")
        print("## Network partition\n")
        table(["Metric", "Value"], [["Runs", len(pt)], ["Passed", f"{passed}/{len(pt)}"]])

    # Load
    ld = rows(os.path.join(d, "load.csv"))
    if ld:
        print("## Autoscaling under load\n")
        table(
            ["Metric", "Value"],
            [
                ["Runs", len(ld)],
                ["Replicas before load", stat(ld, "replicas_before", digits=0)],
                ["Peak desired replicas", stat(ld, "peak_desired", digits=0)],
                ["Peak ready replicas", stat(ld, "peak_ready", digits=0)],
                ["First scale decision (s)", stat(ld, "first_scale_decision_s")],
                ["First new replica Ready (s)", stat(ld, "first_new_ready_s")],
                ["Latency p50 (ms)", stat(ld, "p50_ms")],
                ["Latency p95 (ms)", stat(ld, "p95_ms")],
                ["Failed requests", f"{total(ld,'failed')} of {total(ld,'requests')}"],
                ["Scale-down time (s)", stat(ld, "scaledown_s", digits=0)],
            ],
        )

    # Cold start
    cs = rows(os.path.join(d, "coldstart.csv"))
    if cs:
        print("## Cold start (0 → N replicas, time until Ready)\n")
        table(["Metric", "Value"], [["Runs", len(cs)], ["Ready time (ms)", stat(cs, "ready_ms", digits=0)]])

    # Migration
    mg = rows(os.path.join(d, "migration.csv"))
    if mg:
        ok = sum(1 for r in mg if r["expand_status"] == r["verify_status"] == r["contract_status"] == "ok")
        print("## Migration under traffic\n")
        table(
            ["Metric", "Value"],
            [
                ["Runs", len(mg)],
                ["All three phases succeeded", f"{ok}/{len(mg)}"],
                ["Expand (ms)", stat(mg, "expand_ms", digits=0)],
                ["Verify (ms)", stat(mg, "verify_ms", digits=0)],
                ["Contract (ms)", stat(mg, "contract_ms", digits=0)],
                ["Total (ms)", stat(mg, "total_ms", digits=0)],
                ["Failed requests during migration", f"{total(mg,'window_failed')} of {total(mg,'window_requests')}"],
                ["Failed requests in baseline (before migration)", f"{total(mg,'baseline_failed')} of {total(mg,'baseline_requests')}"],
            ],
        )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: summarize.py <results_dir>")
    main(sys.argv[1])