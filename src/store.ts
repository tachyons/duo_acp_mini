import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';

export interface PersistedSession {
  sessionId: string;
  cwd: string;
  modelId: string;
  messages: ModelMessage[];
}

function sessionsDir(): string {
  const base = process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share');
  return path.join(base, 'duo-acp', 'sessions');
}

function sessionFile(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

export function saveSession(session: PersistedSession): void {
  try {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(sessionFile(session.sessionId), JSON.stringify(session), { mode: 0o600 });
  } catch {
    // persistence is best-effort
  }
}

export function loadSession(sessionId: string): PersistedSession | null {
  try {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) return null;
    const data = JSON.parse(readFileSync(sessionFile(sessionId), 'utf8')) as PersistedSession;
    if (data.sessionId === sessionId && Array.isArray(data.messages)) {
      return data;
    }
  } catch {
    // not found or corrupt
  }
  return null;
}
