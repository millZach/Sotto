#!/usr/bin/env bash
# stop.sh <pid>: stops Electron by PID, then anything left in its session (the fake CLI, a zygote), by PID.
pid=$1
kill -TERM "$pid" 2>/dev/null || true
for _ in $(seq 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
kill -KILL "$pid" 2>/dev/null || true
for left in $(pgrep -s "$pid" || true); do kill -KILL "$left" 2>/dev/null || true; done
