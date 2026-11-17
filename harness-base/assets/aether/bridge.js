import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

const PROTOCOL = 'aether-jsonrpc-v1';
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const decoder = new TextDecoder('utf-8', { fatal: true });

export class AetherBridgeError extends Error {
  constructor(code, message, { ambiguous = false, details } = {}) {
    super(message);
    this.name = 'AetherBridgeError';
    this.code = code;
    this.ambiguous = Boolean(ambiguous);
    if (details !== undefined) this.details = details;
  }
}

function pathKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function optionPaths(options, single, multiple) {
  const paths = [];
  if (options[single] !== undefined) paths.push(options[single]);
  if (options[multiple] !== undefined) {
    if (!Array.isArray(options[multiple])) {
      throw new AetherBridgeError('INVALID_OPTIONS', `${multiple} must be an array of paths`);
    }
    paths.push(...options[multiple]);
  }
  if (paths.some(path => typeof path !== 'string' || !path.trim())) {
    throw new AetherBridgeError('INVALID_OPTIONS', `${single} must contain nonempty directory paths`);
  }
  return paths.map(path => resolve(path));
}

function runtimeDirectories(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new AetherBridgeError('INVALID_OPTIONS', 'Discovery options must be an object');
  }
  const homes = optionPaths(options, 'home', 'homePaths');
  const explicitRuntime = optionPaths(options, 'runtimeDir', 'runtimeDirs');
  const workspaces = optionPaths(options, 'workspace', 'workspacePaths');
  if (options.cwd !== undefined) {
    if (typeof options.cwd !== 'string' || !options.cwd.trim()) {
      throw new AetherBridgeError('INVALID_OPTIONS', 'cwd must be a nonempty directory path');
    }
    workspaces.push(resolve(options.cwd));
  }
  const directories = new Map();
  const addDirectory = path => directories.set(pathKey(path), path);
  const addHome = home => {
    if (basename(home).toLowerCase() === '.runtime') addDirectory(home);
    addDirectory(join(home, '.runtime'));
    addDirectory(join(home, 'dist', 'AetherMotionStudio', '.runtime'));
  };
  for (const path of explicitRuntime) addDirectory(path);
  for (const home of homes) addHome(home);
  // Explicit directories scope discovery to the configured installation.
  if (homes.length || explicitRuntime.length) return [...directories.values()];
  const environmentHome = process.env.QCODERI_AETHER_HOME;
  if (environmentHome?.trim()) addHome(resolve(environmentHome));
  if (!workspaces.length) workspaces.push(process.cwd());
  for (const workspace of workspaces) {
    let parent = workspace;
    while (true) {
      addHome(parent);
      for (const name of ['IAAnimeshAETHER', 'AETHER', 'AetherMotionStudio']) {
        addHome(join(parent, name));
      }
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  if (process.platform === 'win32') addHome('G:\\IAAnimeshAETHER');
  return [...directories.values()];
}

async function readMetadata(metadataPath) {
  const match = /^bridge-([1-9]\d*)\.json$/i.exec(basename(metadataPath));
  if (!match) {
    throw new AetherBridgeError('METADATA_INVALID', 'Session metadata must be named bridge-PID.json');
  }
  let handle;
  let metadata;
  try {
    handle = await fs.open(metadataPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new AetherBridgeError('METADATA_INVALID', 'Session metadata must be a regular file');
    }
    if (stat.size > MAX_METADATA_BYTES) {
      throw new AetherBridgeError('METADATA_TOO_LARGE', 'Session metadata exceeds 64 KiB');
    }
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_METADATA_BYTES) {
      throw new AetherBridgeError('METADATA_TOO_LARGE', 'Session metadata exceeds 64 KiB');
    }
    try {
      metadata = JSON.parse(decoder.decode(buffer.subarray(0, length)));
    } catch {
      // Parser exceptions can contain metadata text, including the private token.
      throw new AetherBridgeError('METADATA_INVALID', 'Session metadata contains invalid UTF-8 or JSON');
    }
  } catch (error) {
    if (error instanceof AetherBridgeError) throw error;
    throw new AetherBridgeError('METADATA_UNAVAILABLE', 'Session metadata could not be read', {
      details: { system_code: typeof error.code === 'string' ? error.code : 'UNKNOWN' },
    });
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  const socketMatch = typeof metadata?.socket === 'string'
    ? /^AetherMotion-[a-f0-9]{12}-([1-9]\d*)-[a-f0-9]{10}$/.exec(metadata.socket)
    : null;
  const validPid = Number.isSafeInteger(metadata?.pid) && metadata.pid > 0 && metadata.pid <= 0xffffffff;
  const validToken = typeof metadata?.token === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(metadata.token);
  const validStarted = metadata?.started_at === undefined
    || (typeof metadata.started_at === 'number' && Number.isFinite(metadata.started_at) && metadata.started_at > 0);
  if (!metadata || Array.isArray(metadata) || metadata.protocol !== PROTOCOL || !validPid
    || !socketMatch || Number(socketMatch[1]) !== metadata.pid || Number(match[1]) !== metadata.pid
    || !validToken || !validStarted) {
    throw new AetherBridgeError('METADATA_INVALID', 'Session metadata has invalid protocol, socket, PID, token, or start time');
  }
  return metadata;
}

function publicDescriptor(metadata, metadataPath) {
  const id = createHash('sha256').update(pathKey(metadataPath)).update('\0').update(metadata.socket).digest('hex').slice(0, 20);
  const descriptor = {
    id: `aether-${metadata.pid}-${id}`,
    pid: metadata.pid,
    metadata_path: metadataPath,
    app_directory: dirname(dirname(metadataPath)),
    protocol: metadata.protocol,
    socket: metadata.socket,
  };
  if (metadata.started_at !== undefined) descriptor.started_at = metadata.started_at;
  return descriptor;
}

/** Discover metadata without contacting the editor. Probe with bridge.get_session separately. */
export async function discoverSessions(options = {}) {
  const sessions = new Map();
  for (const directory of runtimeDirectories(options)) {
    let files;
    try {
      files = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) continue;
      throw new AetherBridgeError('METADATA_UNAVAILABLE', 'A session metadata directory could not be read', {
        details: { system_code: typeof error.code === 'string' ? error.code : 'UNKNOWN' },
      });
    }
    for (const file of files) {
      if (!file.isFile() || !/^bridge-[1-9]\d*\.json$/i.test(file.name)) continue;
      const metadataPath = resolve(directory, file.name);
      if (sessions.has(pathKey(metadataPath))) continue;
      try {
        const metadata = await readMetadata(metadataPath);
        sessions.set(pathKey(metadataPath), publicDescriptor(metadata, metadataPath));
      } catch (error) {
        if (!(error instanceof AetherBridgeError)) throw error;
      }
    }
  }
  return [...sessions.values()].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0)
    || a.metadata_path.localeCompare(b.metadata_path));
}

function requestBytes(metadata, method, params, id) {
  let serialized;
  try {
    serialized = JSON.stringify({ jsonrpc: '2.0', id, token: metadata.token, method, params }, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite number');
      return value;
    });
  } catch {
    throw new AetherBridgeError('INVALID_REQUEST', 'Request parameters must be serializable JSON with finite numbers');
  }
  const size = Buffer.byteLength(serialized, 'utf8') + 1;
  if (size > MAX_REQUEST_BYTES) {
    throw new AetherBridgeError('REQUEST_TOO_LARGE', 'Request exceeds 2 MiB');
  }
  return Buffer.from(`${serialized}\n`, 'utf8');
}

function parseResponse(bytes, id) {
  let response;
  try {
    response = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new AetherBridgeError('INVALID_RESPONSE', 'Editor returned invalid UTF-8 or JSON', { ambiguous: true });
  }
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.jsonrpc !== '2.0') {
    throw new AetherBridgeError('INVALID_RESPONSE', 'Editor returned an invalid JSON-RPC response', { ambiguous: true });
  }
  if (response.id !== id) {
    throw new AetherBridgeError('RESPONSE_ID_MISMATCH', 'Editor returned a different request ID', { ambiguous: true });
  }
  const hasResult = Object.hasOwn(response, 'result');
  const hasError = Object.hasOwn(response, 'error');
  const validError = !hasError || (response.error && typeof response.error === 'object'
    && !Array.isArray(response.error) && Number.isInteger(response.error.code) && typeof response.error.message === 'string');
  if (hasResult === hasError || !validError) {
    throw new AetherBridgeError('INVALID_RESPONSE', 'Editor returned an invalid result or error envelope', { ambiguous: true });
  }
  return response;
}

/** Send exactly one request to the selected editor and return its JSON-RPC envelope. */
export async function callSession(session, method, params = {}, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new AetherBridgeError('INVALID_OPTIONS', 'Request options must be an object');
  }
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const metadataPath = typeof session === 'string' ? session : session?.metadata_path;
  if (typeof metadataPath !== 'string' || !metadataPath.trim()) {
    throw new AetherBridgeError('INVALID_SESSION', 'Select a session descriptor or metadata path');
  }
  if (typeof method !== 'string' || !method.trim() || !params || typeof params !== 'object' || Array.isArray(params)) {
    throw new AetherBridgeError('INVALID_REQUEST', 'Method must be a nonempty string and params must be an object');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) {
    throw new AetherBridgeError('INVALID_OPTIONS', 'timeoutMs must be positive and at most 2147483647');
  }
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
    throw new AetherBridgeError('INVALID_OPTIONS', 'signal must be an AbortSignal');
  }
  if (signal?.aborted) throw new AetherBridgeError('ABORTED', 'AETHER request was cancelled');
  return new Promise((resolveCall, rejectCall) => {
    let socket;
    let sent = false;
    let settled = false;
    let responseLength = 0;
    const chunks = [];
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (socket) {
        socket.removeAllListeners('connect');
        socket.removeAllListeners('data');
        socket.removeAllListeners('end');
        socket.removeAllListeners('close');
        // Keep the error listener until destruction completes to consume queued OS errors.
        socket.destroy();
      }
      chunks.length = 0;
      if (error) rejectCall(error);
      else resolveCall(response);
    };
    const fail = (code, message, details) => finish(new AetherBridgeError(code, message, { ambiguous: sent, details }));
    const onAbort = () => fail('ABORTED', 'AETHER request was cancelled');
    const timer = setTimeout(() => fail('TIMEOUT', 'AETHER request timed out'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    const connect = async () => {
      const path = resolve(metadataPath);
      const metadata = await readMetadata(path);
      if (settled) return;
      if (typeof session === 'object' && (session.pid !== metadata.pid || session.socket !== metadata.socket
        || session.protocol !== metadata.protocol)) {
        throw new AetherBridgeError('SESSION_CHANGED', 'Selected editor session changed. Discover and select the current session');
      }
      const id = randomUUID();
      const request = requestBytes(metadata, method, params, id);
      if (settled) return;
      const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${metadata.socket}` : metadata.socket;
      socket = createConnection({ path: pipe });
      socket.once('connect', () => {
        if (settled) return;
        try {
          // A write attempt can deliver bytes even if an error follows. Never replay it.
          sent = true;
          socket.write(request);
        } catch (error) {
          fail('REQUEST_FAILED', 'AETHER request could not be sent', {
            system_code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
          });
        }
      });
      socket.on('error', error => fail(sent ? 'REQUEST_FAILED' : 'CONNECT_FAILED', 'AETHER connection failed', {
        system_code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
      }));
      socket.once('end', () => fail('CONNECTION_CLOSED', 'Editor closed the connection before a complete response'));
      socket.once('close', () => fail('CONNECTION_CLOSED', 'Editor connection closed before a complete response'));
      socket.on('data', chunk => {
        if (settled) return;
        const newline = chunk.indexOf(0x0a);
        const length = newline < 0 ? chunk.length : newline + 1;
        responseLength += length;
        if (responseLength > MAX_RESPONSE_BYTES) {
          fail('RESPONSE_TOO_LARGE', 'Editor response exceeds 32 MiB');
          return;
        }
        chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline));
        if (newline < 0) return;
        try {
          finish(null, parseResponse(Buffer.concat(chunks), id));
        } catch (error) {
          finish(error);
        }
      });
    };
    connect().catch(error => finish(error instanceof AetherBridgeError ? error
      : new AetherBridgeError('CONNECT_FAILED', 'AETHER connection could not be initialized', { ambiguous: sent })));
  });
}
