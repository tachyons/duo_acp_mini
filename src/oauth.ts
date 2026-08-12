import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { OPENCODE_GITLAB_AUTH_CLIENT_ID } from 'gitlab-ai-provider';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  instanceUrl: string;
}

const CLIENT_ID = process.env.GITLAB_OAUTH_CLIENT_ID ?? "7dc7f5cfcad711feacde5d021a40403a66b3d3d1affabfbada63dc9fe91ec980";
const SCOPE = 'api';
const EXPIRY_SKEW_MS = 60_000;

function tokenFilePath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config');
  return path.join(base, 'duo-acp', 'auth.json');
}

export function loadTokens(instanceUrl: string): StoredTokens | null {
  try {
    const data = JSON.parse(readFileSync(tokenFilePath(), 'utf8')) as StoredTokens;
    if (data.instanceUrl === instanceUrl && data.accessToken && data.refreshToken) {
      return data;
    }
  } catch {
    // no stored tokens
  }
  return null;
}

export function saveTokens(tokens: StoredTokens): void {
  const file = tokenFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceAuthorization(instanceUrl: string): Promise<DeviceAuthorization> {
  const res = await fetch(`${instanceUrl}/oauth/authorize_device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!res.ok) {
    throw new Error(`Device authorization failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DeviceAuthorization;
}

function toStoredTokens(
  json: { access_token: string; refresh_token: string; expires_in?: number; created_at?: number },
  instanceUrl: string
): StoredTokens {
  const createdAtMs = json.created_at ? json.created_at * 1000 : Date.now();
  const expiresAt = createdAtMs + (json.expires_in ?? 7200) * 1000;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt,
    instanceUrl,
  };
}

export async function pollForDeviceToken(
  instanceUrl: string,
  device: DeviceAuthorization
): Promise<StoredTokens> {
  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = (device.interval || 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await fetch(`${instanceUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
      }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.ok && typeof json.access_token === 'string') {
      const tokens = toStoredTokens(json as never, instanceUrl);
      saveTokens(tokens);
      return tokens;
    }
    const error = json.error as string | undefined;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    throw new Error(`Device token request failed: ${error ?? res.status}`);
  }
  throw new Error('Device authorization timed out');
}

export async function refreshTokens(tokens: StoredTokens): Promise<StoredTokens> {
  const res = await fetch(`${tokens.instanceUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }),
  });
  if (!res.ok) {
    const errorText = await res.text();
    // If refresh token is also expired/invalid, we need full re-authentication
    if (res.status === 401 || res.status === 400) {
      throw new Error(`Refresh token invalid or expired. Re-authentication required.`);
    }
    throw new Error(`Token refresh failed: ${res.status} ${errorText}`);
  }
  const refreshed = toStoredTokens((await res.json()) as never, tokens.instanceUrl);
  saveTokens(refreshed);
  return refreshed;
}

export async function getValidTokens(instanceUrl: string): Promise<StoredTokens | null> {
  let tokens = loadTokens(instanceUrl);
  if (!tokens) return null;
  if (Date.now() >= tokens.expiresAt - EXPIRY_SKEW_MS) {
    try {
      tokens = await refreshTokens(tokens);
    } catch (error) {
      // If refresh fails, clear the invalid tokens
      process.stderr.write(
        `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`
      );
      return null;
    }
  }
  return tokens;
}

/**
 * Helper to handle 401 errors by refreshing the token and retrying once.
 * Use this wrapper for API calls that may receive 401 responses.
 */
export async function fetchWithTokenRefresh(
  url: string,
  options: RequestInit,
  tokens: StoredTokens
): Promise<Response> {
  let response = await fetch(url, options);

  // If we get a 401, try refreshing the token once and retry
  if (response.status === 401) {
    try {
      const refreshed = await refreshTokens(tokens);

      // Update the Authorization header with the new token
      const newOptions = {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${refreshed.accessToken}`,
        },
      };

      response = await fetch(url, newOptions);
    } catch (error) {
      // If refresh fails, return the original 401 response
      // The caller should handle this by re-authenticating
      process.stderr.write(`Token refresh failed on 401: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    }
  }

  return response;
}
