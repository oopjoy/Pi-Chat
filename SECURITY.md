# Security Policy

## Scope

Pi Chat is a Windows-first, local-first client for a Pi RPC service. The default deployment listens on the loopback interface and is not intended to be exposed as a remote multi-user service.

Security boundaries that are especially important include:

- loopback HTTP/SSE transport, Host/Origin checks, and request-token admission;
- Pi Runtime, Session JSONL, and tool execution remaining authoritative outside the browser;
- staged build and live-`dist` safety checks;
- prompt, Runtime-generation, Session, navigation, and terminal fencing;
- file-path validation in the read-only Files / Changes inspector.

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability. Use GitHub's private **Report a vulnerability** flow for this repository, or contact the repository maintainer through a private GitHub channel if that flow is unavailable.

Include:

1. the affected version or commit;
2. a concise description of the impact and attack preconditions;
3. reproducible steps or a minimal proof of concept;
4. any relevant logs with prompts, credentials, absolute paths, and other private data removed.

We will acknowledge a report when practical, investigate it in a private branch, and publish a fix or mitigation in the release notes when appropriate. Do not include live Session JSONL, provider credentials, API tokens, or private workspace files in a report.

## Supported versions

The latest GitHub Release is the primary supported version. Development snapshots may contain incomplete changes and should not be exposed beyond the local machine.
