import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

export interface ToolSessionContext {
  sessionId: string;
  cwd: string;
  client: acp.AgentContext;
  alwaysAllowedWrites: boolean;
}

function resolvePath(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

async function notifyToolCall(
  ctx: ToolSessionContext,
  update: Record<string, unknown>
): Promise<void> {
  await ctx.client.notify(acp.methods.client.session.update, {
    sessionId: ctx.sessionId,
    update,
  } as never);
}

async function requestWritePermission(
  ctx: ToolSessionContext,
  toolCallId: string,
  title: string,
  filePath: string,
  oldText: string | null,
  newText: string
): Promise<boolean> {
  if (ctx.alwaysAllowedWrites) return true;

  const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
    sessionId: ctx.sessionId,
    toolCall: {
      toolCallId,
      title,
      kind: 'edit',
      status: 'pending',
      locations: [{ path: filePath }],
      content: [{ type: 'diff', path: filePath, oldText, newText }],
    },
    options: [
      { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
      { kind: 'allow_always', name: 'Always allow edits', optionId: 'allow_always' },
      { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
    ],
  });

  if (response.outcome.outcome !== 'selected') return false;
  if (response.outcome.optionId === 'allow_always') {
    ctx.alwaysAllowedWrites = true;
    return true;
  }
  return response.outcome.optionId === 'allow';
}

export function buildTools(ctx: ToolSessionContext): ToolSet {
  return {
    read_file: tool({
      description:
        'Read the contents of a text file. Returns the file content, optionally from a starting line with a line limit.',
      inputSchema: z.object({
        path: z.string().describe('Path to the file (absolute or relative to the project root)'),
        line: z.number().int().min(1).optional().describe('1-based line number to start from'),
        limit: z.number().int().min(1).optional().describe('Maximum number of lines to read'),
      }),
      execute: async ({ path: p, line, limit }, { toolCallId }) => {
        const filePath = resolvePath(ctx.cwd, p);
        await notifyToolCall(ctx, {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: `Read ${p}`,
          kind: 'read',
          status: 'in_progress',
          locations: [{ path: filePath }],
          rawInput: { path: filePath, line, limit },
        });
        try {
          const res = await ctx.client.request(acp.methods.client.fs.readTextFile, {
            sessionId: ctx.sessionId,
            path: filePath,
            line: line ?? null,
            limit: limit ?? null,
          });
          await notifyToolCall(ctx, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
          });
          return res.content;
        } catch (err) {
          await notifyToolCall(ctx, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
          });
          return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    write_file: tool({
      description:
        'Create a new file or overwrite an existing file with the given content. Requires user approval.',
      inputSchema: z.object({
        path: z.string().describe('Path to the file (absolute or relative to the project root)'),
        content: z.string().describe('Full content to write to the file'),
      }),
      execute: async ({ path: p, content }, { toolCallId }) => {
        const filePath = resolvePath(ctx.cwd, p);
        let oldText: string | null = null;
        try {
          const existing = await ctx.client.request(acp.methods.client.fs.readTextFile, {
            sessionId: ctx.sessionId,
            path: filePath,
          });
          oldText = existing.content;
        } catch {
          // new file
        }

        const approved = await requestWritePermission(
          ctx,
          toolCallId,
          `Write ${p}`,
          filePath,
          oldText,
          content
        );
        if (!approved) {
          await notifyToolCall(ctx, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
          });
          return 'The user rejected this file write.';
        }

        try {
          await ctx.client.request(acp.methods.client.fs.writeTextFile, { sessionId: ctx.sessionId, path: filePath, content });
          await notifyToolCall(ctx, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            content: [{ type: 'diff', path: filePath, oldText, newText: content }],
          });
          return `Wrote ${filePath}`;
        } catch (err) {
          await notifyToolCall(ctx, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
          });
          return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    edit_file: tool({
      description:
        'Edit a file by replacing an exact string with a new string. The old_string must appear exactly once in the file. Requires user approval.',
      inputSchema: z.object({
        path: z.string().describe('Path to the file (absolute or relative to the project root)'),
        old_string: z.string().describe('Exact text to replace (must be unique in the file)'),
        new_string: z.string().describe('Replacement text'),
      }),
      execute: async ({ path: p, old_string, new_string }, { toolCallId }) => {
        const filePath = resolvePath(ctx.cwd, p);
        let original: string;
        try {
          const res = await ctx.client.request(acp.methods.client.fs.readTextFile, { sessionId: ctx.sessionId, path: filePath });
          original = res.content;
        } catch (err) {
          return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
        }

        const occurrences = original.split(old_string).length - 1;
        if (occurrences === 0) {
          return 'Error: old_string not found in file.';
        }
        if (occurrences > 1) {
          return `Error: old_string appears ${occurrences} times; it must be unique. Add more surrounding context.`;
        }

        const updated = original.replace(old_string, new_string);
        const approved = await requestWritePermission(
          ctx,
          toolCallId,
          `Edit ${p}`,
          filePath,
          original,
          updated
        );
        if (!approved) {
          await notifyToolCall(ctx, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
          });
          return 'The user rejected this edit.';
        }

        try {
          await ctx.client.request(acp.methods.client.fs.writeTextFile, {
            sessionId: ctx.sessionId,
            path: filePath,
            content: updated,
          });
          await notifyToolCall(ctx, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            content: [{ type: 'diff', path: filePath, oldText: original, newText: updated }],
          });
          return `Edited ${filePath}`;
        } catch (err) {
          await notifyToolCall(ctx, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
          });
          return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
