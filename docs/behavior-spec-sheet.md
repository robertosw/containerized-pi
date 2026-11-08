# Pi Containerization Behavior Spec

## Goal
Run `pi` through Podman with local-command ergonomics, isolated execution, live workspace access, and limited persistent agent state.

## Core Intent
Containerization must provide four properties:
- host user can call `pi` like local command
- agent runs inside container, not on host
- current host workspace is available live inside container
- selected agent state survives across runs

## Host Entry Contract
A small host-side launcher must act as stable entry point.

Intent:
- hide container invocation details from user
- forward user arguments into containerized `pi`
- preserve interactive terminal behavior when available
- keep image selection explicit and deterministic
- ask before exposing more than the current working directory

## Image Contract
Image must contain complete execution environment for `pi`.

Intent:
- package required runtime tools
- define default working context for mounted workspace
- include repository-shipped agent assets
- define bootstrap handoff before main command starts

## Workspace Contract
Host working directory must be exposed inside container as live working tree.

Intent:
- let `pi` read and modify real project files
- avoid copy-based sync during normal launches
- make host changes immediately visible in container session
- mirror host directory names in container paths from the mount anchor down
- widen the mount to the git root only after explicit user confirmation
- refuse mounts whose target name would shadow container system directories

## Persistence Contract
Agent state must persist separately from workspace.

Intent:
- keep container runs ephemeral
- preserve selected agent files across runs
- separate durable agent state from project files
- allow startup logic to reconcile persisted state with image-managed defaults

## Startup Bootstrap Contract
Every launch must pass through bootstrap before final command execution.

Intent:
- prepare agent home
- enforce repository-managed prompt bootstrap content
- refresh shipped assets into runtime-visible agent locations
- load persisted secrets into process environment
- hand off cleanly to requested final command

## Prompt Contract
Prompt augmentation is image-managed, not user-persistent.

Intent:
- ensure startup prompt state matches shipped container behavior
- prevent stale persisted prompt files from overriding image intent
- make prompt updates take effect through rebuild plus restart

## Shipped Asset Contract
Repository-shipped extensions and skills are image-owned defaults that must be reapplied into persistent runtime state.

Intent:
- keep runtime lookup paths stable
- treat image as source of truth for shipped assets
- prevent stale persisted copies from surviving after shipped asset changes
- limit refresh scope so unrelated persisted agent files remain intact

## Secret Contract
Persisted secrets may be stored in agent state, then exposed to runtime as environment variables during bootstrap.

Intent:
- keep secret entry separate from image build
- preserve secrets across ephemeral runs
- ensure tools receive secrets through process environment before execution

## Command Handoff Contract
Bootstrap must end by replacing itself with requested command.

Intent:
- keep bootstrap separate from main process logic
- preserve argument passthrough semantics
- ensure normal `pi` execution and alternate command forms share same preparation path

## Update Model
Two update mechanisms must remain distinct.

Intent:
- image changes require rebuild
- bootstrap-managed runtime files refresh on next container start
- persistent state must not block shipped updates from taking effect

## Design Summary
System splits into three layers:
1. host launcher provides local-command ergonomics
2. image provides isolated execution environment and shipped defaults
3. startup bootstrap reconciles persistent runtime state before command execution

Desired outcome: containerized `pi` feels local to user, stays isolated from host, sees live workspace, and preserves only intended agent state.