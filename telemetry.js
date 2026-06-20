// telemetry.js — minimal, dependency-free TelemetryDeck custom-signal sender.
//
// The Web SDK script in index.html sends one pageview per load and exposes no
// API. This module sends typed action signals (export / open / import / new /
// save / undo / redo) to the SAME app via TelemetryDeck's v2 ingest endpoint.
// It is fire-and-forget and never throws into the app — analytics must not be
// able to break the editor.
//
// Payload shape verified against the official JS SDK source
// (TelemetryDeck/JavaScriptSDK/src/telemetrydeck.js): POST a JSON ARRAY of
// signal objects; clientUser is SHA-256(clientUser + salt) with an empty salt.

import { APP_VERSION } from './model.js';

const TARGET = 'https://nom.telemetrydeck.com/v2/';

// Single source of truth for the app ID: the Web SDK <script data-app-id>.
const sdkTag = document.querySelector('script[data-app-id]');
const APP_ID = sdkTag ? sdkTag.dataset.appId : '';

// Mirror the Web SDK's test-mode rule so local dev / headless tests never
// pollute production data.
const TEST_MODE =
  /^localhost$|^127(\.\d+){0,2}\.\d+$|^\[::1?\]$/.test(location.hostname) ||
  location.protocol === 'file:';

function randomId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// One session ID per page load (groups a visit's actions).
const sessionID = randomId();

// Stable anonymous user, persisted per browser. Falls back to the session ID
// when localStorage is unavailable (e.g. private mode).
function anonUser() {
  try {
    let id = localStorage.getItem('td-anon-user');
    if (!id) {
      id = randomId();
      localStorage.setItem('td-anon-user', id);
    }
    return id;
  } catch (_) {
    return sessionID;
  }
}

async function sha256hex(s) {
  // crypto.subtle requires a secure context (https or localhost). If absent
  // (plain http on a non-localhost host) we send the raw random id — still
  // anonymous, just not hashed.
  if (!(crypto && crypto.subtle)) return s;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return s;
  }
}

// Send one typed signal. Optional payload is an object; values are stringified
// (a `floatValue` key is kept numeric, matching the TelemetryDeck convention).
export async function signal(type, payload) {
  if (!APP_ID || !type) return;
  try {
    const clientUser = await sha256hex(anonUser());
    const body = {
      clientUser,
      sessionID,
      appID: APP_ID,
      type,
      telemetryClientVersion: `IconRecomposer ${APP_VERSION}`,
    };
    if (TEST_MODE) body.isTestMode = true;
    // Tag every signal with the app version so TelemetryDeck can break usage
    // down by version (its standard "App Version" dimension reads this key).
    const p = { 'TelemetryDeck.AppInfo.version': APP_VERSION };
    if (payload && typeof payload === 'object') {
      for (const [k, v] of Object.entries(payload)) {
        p[k] = k === 'floatValue' && typeof v === 'number' ? v : String(v);
      }
    }
    body.payload = p;
    await fetch(TARGET, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([body]),
    });
  } catch (_) {
    /* analytics must never break the app */
  }
}

// ---- error reporting ----
// Sends `error` signals for both explicit app failures (export/import/open) and
// uncaught runtime errors. Deduped + capped so a repeating error can't flood.
const seenErrors = new Set();
let errorCount = 0;
const MAX_ERRORS = 25;

export function reportError(message, context) {
  const msg = String(message == null ? 'unknown error' : (message.message || message)).slice(0, 300);
  const key = (context || '') + '|' + msg;
  if (seenErrors.has(key) || errorCount >= MAX_ERRORS) return;
  seenErrors.add(key);
  errorCount += 1;
  const payload = { message: msg };
  if (context) payload.context = String(context);
  signal('error', payload); // fire-and-forget (signal() never rejects)
}

// Global safety net for anything the app didn't catch explicitly.
if (typeof window !== 'undefined' && APP_ID) {
  window.addEventListener('error', (e) => {
    const file = e.filename ? ` (${String(e.filename).split('/').pop()}:${e.lineno || 0})` : '';
    reportError((e.message || 'error') + file, 'window.onerror');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    reportError((r && r.message) || (r != null ? String(r) : 'unhandledrejection'), 'unhandledrejection');
  });
}
