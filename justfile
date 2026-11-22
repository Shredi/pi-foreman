set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# Optional task runner: CI does not use this file (see docs/development.md, Task runner).

# List the recipes.
default:
    just --list

# Python unit tests (npm test).
test:
    npm test

# Node tests for the extensions and herdr-app mods (npm run test:node).
test-node:
    npm run test:node

# Installer tests (tests/installer).
test-installer:
    npm run test:installer

# Type check of the Pi extensions.
typecheck:
    npm run typecheck

# Every linter: ruff (version pinned in .github/lint-requirements.txt), the type check and oxlint (npm run lint:ts).
lint:
    ruff check .
    npm run typecheck
    npm run lint:ts

# Everything CI runs that a local machine can (npm run test:ci).
ci:
    npm run test:ci
