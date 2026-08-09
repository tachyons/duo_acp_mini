#!/usr/bin/env node
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as acp from '@agentclientprotocol/sdk';
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { createGitLab, MODEL_MAPPINGS } from 'gitlab-ai-provider';
import { getValidTokens, startDeviceAuthorization, pollForDeviceToken } from './oauth.js';
import { buildTools, type ToolSessionContext } from './tools.js';

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.name === 'APIUserAbortError' ||
      err.message.includes('aborted'))
  );
}

process.on('unhandledRejection', (err) => {
  if (isAbortError(err)) return;
  process.stderr.write(`Unhandled rejection: ${err instanceof Error ? err.stack : err}\n`);
});

process.on('uncaughtException', (err) => {
  if (isAbortError(err)) return;
  process.stderr.write(`Uncaught exception: ${err.stack}\n`);
});

const INSTANCE_URL = process.env.GITLAB_INSTANCE_URL ?? 'https://gitlab.com';
const DEFAULT_MODEL = 'duo-chat-sonnet-4-5';
const MODEL_IDS = Object.keys(MODEL_MAPPINGS);
const MAX_STEPS = 25;

const SYSTEM_PROMPT =
  'You are GitLab Duo, a coding assistant running inside a code editor. ' +
  'You can read and modify files in the user workspace using the provided tools. ' +
  'Use read_file to inspect files before editing them. Prefer edit_file for targeted ' +
  'changes and write_file for new files or full rewrites. File paths may be relative ' +
  'to the project root.';

interface Session {
  messages: ModelMessage[];
  abort: AbortController | null;
  modelId: string;
  cwd: string;
  alwaysAllowedWrites: boolean;
}

const sessions = new Map<string, Session>();

let clientFsCapabilities = { readTextFile: false, writeTextFile: false };

function modelConfigOption(currentValue: string): acp.SessionConfigOption {
  return {
    type: 'select',
    id: 'model',
    name: 'Model',
    description: 'GitLab Duo model',
    category: 'model',
    currentValue,
    options: MODEL_IDS.map((id) => ({ value: id, name: id })),
  };
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // best effort
  }
}

async function requireAccessToken(): Promise<string> {
  const tokens = await getValidTokens(INSTANCE_URL);
  if (!tokens) {
    throw acp.RequestError.authRequired();
  }
  return tokens.accessToken;
}

function promptToText(prompt: acp.ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'resource_link':
        parts.push(`[Resource: ${block.uri}]`);
        break;
      case 'resource':
        if ('text' in block.resource) {
          parts.push(`[File: ${block.resource.uri}]\n${block.resource.text}`);
        }
        break;
      default:
        break;
    }
  }
  return parts.join('\n\n');
}

async function authenticate(): Promise<acp.AuthenticateResponse> {
  const existing = await getValidTokens(INSTANCE_URL);
  if (existing) return {};

  const device = await startDeviceAuthorization(INSTANCE_URL);
  process.stderr.write(
    `\nGitLab Duo authentication required.\n` +
      `Open: ${device.verification_uri_complete}\n` +
      `Code: ${device.user_code}\n\n`
  );
  openBrowser(device.verification_uri_complete);
  await pollForDeviceToken(INSTANCE_URL, device);
  return {};
}

async function runPrompt(
  params: acp.PromptRequest,
  client: acp.AgentContext
): Promise<acp.PromptResponse> {
  const session = sessions.get(params.sessionId);
  if (!session) {
    throw acp.RequestError.invalidParams(`Session not found: ${params.sessionId}`);
  }

  const accessToken = await requireAccessToken();
  const gitlab = createGitLab({ apiKey: accessToken, instanceUrl: INSTANCE_URL });

  session.abort?.abort();
  const abort = new AbortController();
  session.abort = abort;

  session.messages.push({ role: 'user', content: promptToText(params.prompt) });

  const toolsEnabled = clientFsCapabilities.readTextFile && clientFsCapabilities.writeTextFile;
  const toolCtx: ToolSessionContext = {
    sessionId: params.sessionId,
    cwd: session.cwd,
    client,
    alwaysAllowedWrites: session.alwaysAllowedWrites,
  };

  try {
    const result = streamText({
      model: gitlab.agenticChat(session.modelId),
      system: SYSTEM_PROMPT,
      messages: session.messages,
      abortSignal: abort.signal,
      ...(toolsEnabled
        ? { tools: buildTools(toolCtx), stopWhen: stepCountIs(MAX_STEPS) }
        : {}),
    });

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: part.text },
          },
        });
      }
    }

    const response = await result.response;
    session.messages.push(...response.messages);
    session.alwaysAllowedWrites = toolCtx.alwaysAllowedWrites;

    return { stopReason: abort.signal.aborted ? 'cancelled' : 'end_turn' };
  } catch (err) {
    if (abort.signal.aborted || isAbortError(err)) {
      return { stopReason: 'cancelled' };
    }
    throw err;
  } finally {
    if (session.abort === abort) {
      session.abort = null;
    }
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
);

acp
  .agent({ name: 'gitlab-duo-acp' })
  .onRequest('initialize', (ctx) => {
    const fs = ctx.params.clientCapabilities?.fs;
    clientFsCapabilities = {
      readTextFile: fs?.readTextFile === true,
      writeTextFile: fs?.writeTextFile === true,
    };
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      authMethods: [
        {
          id: 'gitlab-oauth',
          name: 'GitLab OAuth',
          description: 'Sign in to GitLab with the OAuth device flow',
        },
      ],
    };
  })
  .onRequest('authenticate', () => authenticate())
  .onRequest('session/new', async (ctx) => {
    await requireAccessToken();
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      messages: [],
      abort: null,
      modelId: DEFAULT_MODEL,
      cwd: ctx.params.cwd,
      alwaysAllowedWrites: false,
    });
    return {
      sessionId,
      configOptions: [modelConfigOption(DEFAULT_MODEL)],
    };
  })
  .onRequest('session/set_config_option', (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) {
      throw acp.RequestError.invalidParams(`Session not found: ${ctx.params.sessionId}`);
    }
    if (ctx.params.configId === 'model') {
      const value = ctx.params.value;
      if (typeof value !== 'string' || !MODEL_IDS.includes(value)) {
        throw acp.RequestError.invalidParams(`Unknown model: ${String(value)}`);
      }
      session.modelId = value;
    }
    return { configOptions: [modelConfigOption(session.modelId)] };
  })
  .onRequest('session/prompt', (ctx) => runPrompt(ctx.params, ctx.client))
  .onNotification('session/cancel', (ctx) => {
    sessions.get(ctx.params.sessionId)?.abort?.abort();
  })
  .connect(stream);
