import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../config.ts';
import { deleteSecret, getSecret, setSecret } from '../secrets.ts';
import type { RawEvent } from '../types.ts';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

export interface GoogleClient {
  client_id: string;
  client_secret: string;
}

interface Token {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

/** Accepts the JSON Google Cloud Console downloads ({installed: {...}}) or a bare {client_id, client_secret}. */
export function parseClientJson(text: string): GoogleClient {
  const raw = JSON.parse(text);
  const c = raw.installed ?? raw.web ?? raw;
  if (typeof c.client_id !== 'string' || typeof c.client_secret !== 'string' || !c.client_id.endsWith('.apps.googleusercontent.com'))
    throw new Error('Not a Google OAuth client: expected client_id (…apps.googleusercontent.com) and client_secret');
  return { client_id: c.client_id.trim(), client_secret: c.client_secret.trim() };
}

/**
 * The OAuth client: TIMESHEET_GOOGLE_CLIENT_ID/SECRET env vars win (handy for managed
 * setups), otherwise the secret store. Never read from the repo or package.
 */
export function loadClient(): GoogleClient | null {
  const id = process.env.TIMESHEET_GOOGLE_CLIENT_ID;
  const secret = process.env.TIMESHEET_GOOGLE_CLIENT_SECRET;
  if (id && secret) return { client_id: id, client_secret: secret };
  const stored = getSecret('google-client');
  return stored ? (JSON.parse(stored) as GoogleClient) : null;
}

function requireClient(): GoogleClient {
  const c = loadClient();
  if (!c) throw new Error('No Google OAuth client configured; run `timesheet auth` (see README "Google Calendar setup")');
  return c;
}

export function saveClient(client: GoogleClient): void {
  setSecret('google-client', JSON.stringify(parseClientJson(JSON.stringify(client))));
}

/** Imports a downloaded client JSON into the secret store and deletes the plaintext file. */
export function importClientFile(path: string): void {
  saveClient(parseClientJson(readFileSync(path, 'utf8')));
  rmSync(path);
}

export function isConnected(): boolean {
  return getSecret('google-token') !== null;
}

export function disconnect(opts: { forgetClient?: boolean } = {}): void {
  deleteSecret('google-token');
  if (opts.forgetClient) deleteSecret('google-client');
}

function saveToken(t: Token) {
  setSecret('google-token', JSON.stringify(t));
}

async function tokenRequest(params: Record<string, string>): Promise<any> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google token request failed: ${body.error_description ?? body.error ?? res.status}`);
  return body;
}

/** Interactive OAuth desktop flow with PKCE on a loopback redirect. */
export async function authorize(log: (msg: string) => void = console.log): Promise<void> {
  const client = requireClient();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (!code && !err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(err ? `<p>Authorization failed: ${err}</p>` : '<p>Timesheet is connected to Google Calendar. You can close this tab.</p>');
      server.close();
      if (err) reject(new Error(`Authorization failed: ${err}`));
      else if (url.searchParams.get('state') !== state) reject(new Error('OAuth state mismatch'));
      else resolve({ code: code!, redirectUri });
    });
    let redirectUri = '';
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString();
      log(`Opening browser for Google sign-in. If it does not open, visit:\n${auth}`);
      execFile('open', [auth.toString()], () => {});
    });
  });

  const t = await tokenRequest({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  if (!t.refresh_token) throw new Error('Google did not return a refresh token; revoke access and run `timesheet auth` again');
  saveToken({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 });
}

async function accessToken(): Promise<string> {
  const stored = getSecret('google-token');
  if (!stored) throw new Error('Not connected to Google Calendar; run `timesheet auth`');
  const token = JSON.parse(stored) as Token;
  if (token.expires_at - 60_000 > Date.now()) return token.access_token;
  const client = requireClient();
  const t = await tokenRequest({
    refresh_token: token.refresh_token,
    client_id: client.client_id,
    client_secret: client.client_secret,
    grant_type: 'refresh_token',
  }).catch((e: Error) => {
    if (/invalid_grant/.test(e.message)) throw new Error('Google access was revoked or expired; run `timesheet auth` again');
    throw e;
  });
  saveToken({ ...token, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}

async function api(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(API + path);
  url.search = new URLSearchParams(params).toString();
  const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google Calendar API ${res.status}: ${body.error?.message ?? 'request failed'}`);
  return body;
}

export async function listCalendars(): Promise<{ id: string; summary: string; primary: boolean }[]> {
  const body = await api('/users/me/calendarList');
  return (body.items ?? []).map((c: any) => ({ id: c.id, summary: c.summaryOverride ?? c.summary, primary: !!c.primary }));
}

async function listEvents(calendarId: string, from: number, to: number): Promise<any[]> {
  const items: any[] = [];
  let pageToken: string | undefined;
  do {
    const body = await api(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      ...(pageToken ? { pageToken } : {}),
    });
    items.push(...(body.items ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return items;
}

/** Maps a Google event to a meeting (or out-of-office marker), or null if it should not count. */
export function toRawEvent(ev: any, config: Config): RawEvent | null {
  if (ev.status === 'cancelled') return null;
  const allDay = !ev.start?.dateTime;
  const start = allDay ? new Date(`${ev.start.date}T00:00:00`).getTime() : Date.parse(ev.start.dateTime);
  const end = allDay ? new Date(`${ev.end.date}T00:00:00`).getTime() : Date.parse(ev.end.dateTime);
  if (ev.eventType === 'outOfOffice') return { source: 'calendar', start, end, texts: [ev.summary ?? 'Out of office'], outOfOffice: true };
  if (allDay || ev.eventType === 'workingLocation' || ev.eventType === 'focusTime') return null;
  if (ev.transparency === 'transparent') return null;
  const attendees: any[] = ev.attendees ?? [];
  const self = attendees.find((a) => a.self);
  const response = self?.responseStatus;
  if (response === 'declined' && !config.calendar.includeDeclined) return null;
  if (response === 'tentative' && !config.calendar.includeTentative) return null;
  if (response === 'needsAction' && !config.calendar.includeUnanswered) return null;
  if (config.calendar.skipWithoutAttendees && attendees.length <= 1) return null;
  const max = config.calendar.maxMeetingHours;
  const title = ev.summary ?? '(no title)';
  if (max > 0 && end - start > max * 3_600_000)
    return { source: 'calendar', start, end, texts: [title], skipped: `Meeting "${title}" (${Math.round(((end - start) / 3_600_000) * 10) / 10}h) was left out: longer than calendar.maxMeetingHours (${max}h)` };
  return {
    source: 'calendar',
    start,
    end,
    texts: [title],
    project: config.calendar.project ?? config.defaultProject,
  };
}

export async function collectCalendar(config: Config, from: number, to: number): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  for (const id of config.calendar.calendarIds) {
    for (const ev of await listEvents(id, from, to)) {
      const raw = toRawEvent(ev, config);
      if (raw) out.push(raw);
    }
  }
  return out;
}
