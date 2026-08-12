# GitLab Duo ACP Agent

[![npm version](https://badge.fury.io/js/gitlab-duo-acp.svg)](https://www.npmjs.com/package/gitlab-duo-acp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A minimal [Agent Client Protocol (ACP)](https://agentclientprotocol.com) agent for [GitLab Duo](https://about.gitlab.com/gitlab-duo/). Chat with GitLab Duo models from any ACP-compatible client (e.g. [Zed](https://zed.dev)).

## Features

- **OAuth device flow** — no personal access tokens; sign in via your browser
- **Selectable models** — pick any GitLab Duo model (Claude, GPT-5) from the client UI
- **File editing** — read, write, and edit files in your workspace via the editor's file system, with diff previews and user approval for every change
- **Streaming responses** over stdio (newline-delimited JSON-RPC)
- No shell access — the agent cannot run arbitrary commands
- Works with GitLab.com and self-hosted instances

## Requirements

- Node.js 18+
- A GitLab account with Duo access

## Installation

### Option 1: Install from npm (Recommended)

```bash
npm install -g gitlab-duo-acp
```

### Option 2: Install from source

```bash
git clone https://github.com/tachyons/duo_acp_mini.git
cd duo_acp_mini
npm install
npm run build
```

## Usage with Zed

### If installed globally via npm:

Add to Zed's `settings.json` (Cmd+, → "Open Settings"):

```json
{
  "agent_servers": {
    "GitLab Duo": {
      "command": "gitlab-duo-acp"
    }
  }
}
```

### If installed from source:

```json
{
  "agent_servers": {
    "GitLab Duo": {
      "command": "node",
      "args": ["/path/to/duo_acp_mini/dist/agent.js"]
    }
  }
}
```

Then:

1. Open the Agent Panel and start a new "GitLab Duo" thread
2. On first use, click **Authenticate** — your browser opens the GitLab device authorization page
3. Approve the request; the agent is ready
4. Switch models via the thread's **Model** config option

To debug, run `dev: open acp logs` from Zed's command palette.

## Authentication

The agent uses the OAuth 2.0 device flow. Tokens are stored at `~/.config/duo-acp/auth.json` (mode `0600`) and refreshed automatically.

## Configuration

| Environment variable     | Description                             | Default              |
| ------------------------ | --------------------------------------- | -------------------- |
| `GITLAB_INSTANCE_URL`    | GitLab instance URL                     | `https://gitlab.com` |
| `GITLAB_OAUTH_CLIENT_ID` | OAuth application client ID (override)  | bundled client ID    |

For self-hosted instances, set `GITLAB_INSTANCE_URL` in the agent server's `env` and register an OAuth application with the device flow enabled, passing its ID via `GITLAB_OAUTH_CLIENT_ID`.

## Development

```bash
npm run dev     # run from source with tsx
npm run build   # compile to dist/
```

## Protocol support

| Method                       | Notes                                        |
| ---------------------------- | -------------------------------------------- |
| `initialize`                 | Advertises `gitlab-oauth` auth method        |
| `authenticate`               | Runs the OAuth device flow                   |
| `session/new`                | Returns model select in `configOptions`      |
| `session/set_config_option`  | Switches the model for the session           |
| `session/prompt`             | Streams `agent_message_chunk` updates        |
| `session/cancel`             | Aborts the in-flight prompt                  |

## Tools

When the client advertises the `fs` capability, the model gets these tools:

| Tool         | Description                                     | Approval |
| ------------ | ----------------------------------------------- | -------- |
| `read_file`  | Read a file via `fs/read_text_file`             | No       |
| `write_file` | Create/overwrite a file via `fs/write_text_file`| Yes      |
| `edit_file`  | Replace a unique string in a file               | Yes      |

Writes show a diff and require approval via `session/request_permission` ("Always allow edits" is remembered per session). There is no shell/terminal tool — the agent cannot execute commands.

## License

MIT
