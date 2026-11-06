#!/usr/bin/env bash
cd /home/crystation/caffeine-tracker || exit 1
exec bun run serve.ts
