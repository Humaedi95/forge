// Forge — a standalone GitHub-compatible git forge in one Node 22 process.
//
// Serves, from its own in-memory store and without any outside service:
//   * git smart HTTP  — upload-pack (protocol v2) and receive-pack (v0): clone, fetch, push
//   * REST v3         — /api/v3: repositories, issues, pull requests, contents
//   * GraphQL v4      — /api/graphql: viewer, repository, issues, pull requests, node(id:)
//   * MCP             — /mcp: Streamable HTTP, modern server/discover era + legacy initialize
//
// Lifecycle: bind an ephemeral port, POST {"port"} to $MAKEFUN_ENV_URL/register,
// then poll GET $MAKEFUN_ENV_URL/done until {"done": true} and exit 0.
// Authentication: every protected route takes `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`;
// the token names the viewer (adaiversen). When the variable is unset (local development
// without an env), any bearer token is accepted.
//
// Determinism: nothing stored or sent reads the wall clock or unseeded randomness.
// Server-created commits and entities carry one fixed timestamp; ids are sequential.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// constants

const VERSION = '1.0.0';
const SERVER_NAME = 'forge';
const ZERO_OID = '0'.repeat(40);

/** The bearer token the entry accepts; '' means "no token configured, accept any". */
const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The env origin this entry registers with (required). */
const ENV_URL: string = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** The one user the token names. */
const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

/** Fixed timestamp for everything the server creates (2025-01-01T00:00:00Z). */
const FIXED_EPOCH_SEC = 1735689600;
const FIXED_ISO = '2025-01-01T00:00:00Z';
/** Identity stamped into server-created commits. */
const SERVER_IDENTITY = 'Forge <forge@make.fun>';
/** Default branch for every repository. */
const DEFAULT_BRANCH = 'main';

const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------------------
// small utilities

function sha1(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

/** Base64 (standard alphabet) of a UTF-8 string. */
function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Decode base64, ignoring whitespace (GitHub wraps content at 60 columns). */
function b64decode(content: string): string {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
}

/** An opaque, stable global (Relay) id for a repository, issue, pull request or comment. */
function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id back into its kind and key parts, or null when it is not one of ours. */
function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split('/') };
  } catch {
    return null;
  }
}

/** Split a URL path into decoded segments, dropping empty ones. */
function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/** Read a query string into a Map (first value wins, no decoding surprises). */
function queryParams(search: string): Map<string, string> {
  const out = new Map<string, string>();
  if (search === '') return out;
  for (const pair of search.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
    if (out.has(key)) continue;
    out.set(key, eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1)));
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ---------------------------------------------------------------------------
// pkt-lines (the git smart-HTTP framing)

/** Encode one payload as a pkt-line (`<4 hex length><payload>`). */
function pktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = body.length + 4;
  const head = Buffer.allocUnsafe(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

function pktLines(items: readonly (string | Uint8Array | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from a buffer. Returns the packets and the offset just past the
 * last complete packet (the bytes after that offset are raw data, e.g. a packfile).
 */
function decodePktLines(buffer: Buffer, start = 0): { packets: Pkt[]; next: number } {
  const packets: Pkt[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const lenText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, next: offset };
}

/** The text lines of data packets (each payload as a UTF-8 string). */
function pktTextLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// git objects: hash, trees, commits, tags, packs
// ---------------------------------------------------------------------------

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

/** The SHA-1 id of an object: sha1("<type> <size>\0<data>"). */
function hashObject(type: GitObjectType, data: Uint8Array): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Compare tree names the way git sorts them (directories sort as if named "name/"). */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/** Build a tree object from entries (sorted git order). */
function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries. */
function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = buffer.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) break;
    const mode = buffer.subarray(offset, space).toString('utf8');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

interface BuildCommitFields {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

/** Build a commit object. */
function buildCommit(fields: BuildCommitFields): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

interface BuildTagFields {
  object: string;
  type: string;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}

/** Build an annotated tag object. */
function buildTag(fields: BuildTagFields): Buffer {
  const lines = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger} ${fields.timestamp} +0000`,
    '',
    fields.message,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * Everything reachable from `tips` (commits, their trees and blobs, tag targets),
 * looked up through `lookup`. Throws when an object is missing.
 */
function collectReachable(tips: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

// --- packfiles ----------------------------------------------------------------

/** Read one pack entry's type/size varint header. */
function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

/** Read an OFS_DELTA base offset. */
function readPackOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; answers its bytes and the offset past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.from(base);
  const deltaBuffer = Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = deltaBuffer[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA
 * and REF_DELTA. `resolveBase` supplies a base a thin pack leaves out.
 * Throws on any structural problem.
 */
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readPackOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _resolved?: { type: GitObjectType; data: Buffer; oid: string } })._resolved;
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (external === undefined) throw new Error('ref-delta base is neither in the pack nor on the server');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as unknown as { _resolved?: unknown })._resolved = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** Encode one object's pack header: the type/size varint. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), version 2, with a SHA-1 trailer. */
function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// the store: repositories, issues, pull requests
// ---------------------------------------------------------------------------

interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

interface Comment {
  id: number;
  nodeId: string;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Cached REST JSON for this issue (invalidated on any mutation). */
  jsonCache: Buffer | null;
}

interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

interface Pull {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  files: PullFile[];
}

interface Repo {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
  /** Cached packs: key -> pack bytes (invalidated by any ref change). */
  packCache: Map<string, Buffer>;
}

let nextRepoId = 1;
let nextIssueId = 1;
let nextLabelId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

const repos = new Map<string, Repo>();

function createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const id = nextRepoId++;
  const repo: Repo = {
    id,
    nodeId: globalId('Repository', repoKey(owner, name)),
    owner,
    name,
    description,
    private: isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    packCache: new Map(),
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

/** Repositories owned by `owner`, in creation order. */
function listRepos(owner: string): Repo[] {
  const out: Repo[] = [];
  for (const repo of repos.values()) {
    if (repo.owner === owner) out.push(repo);
  }
  return out;
}

/** The commit a ref points at, or null when the ref is absent or not a commit. */
function refCommit(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return oid;
}

/** Walk a commit's ancestry, newest first (parents before their own parents). */
function walkCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** The newest common ancestor of two commits, or null when their histories never meet. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set(walkCommits(repo, a));
  for (const oid of walkCommits(repo, b)) {
    if (ancestorsA.has(oid)) return oid;
  }
  return null;
}

/** Is `ancestor` reachable from `tip` (including tip itself)? */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The tree entries of a commit (or an empty list when the commit is unknown). */
function commitTreeEntries(repo: Repo, commitOid: string): TreeEntry[] {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return [];
  const tree = repo.objects.get(parseCommit(commit.data).tree);
  if (tree === undefined || tree.type !== 'tree') return [];
  return parseTree(tree.data);
}

/** Flatten a tree (commit oid -> Map<path, {oid, mode}>) recursively. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

/** All files of a commit's tree, as path -> blob oid. */
function commitFiles(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return out;
  flattenTree(repo, parseCommit(commit.data).tree, '', out);
  return out;
}

/** The blob oid a commit's tree holds at `path`, or null. */
function treePathBlob(repo: Repo, commitOid: string, path: string): string | null {
  const files = commitFiles(repo, commitOid);
  return files.get(path)?.oid ?? null;
}

/** Count lines of a text (a trailing newline does not add a line). */
function lineCount(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** A line multiset difference: how many lines of `next` are not in `prev`, and vice versa. */
function lineDiff(prev: string, next: string): { additions: number; deletions: number } {
  const prevLines = prev === '' ? [] : prev.split('\n');
  const nextLines = next === '' ? [] : next.split('\n');
  if (prevLines.length > 0 && prevLines[prevLines.length - 1] === '') prevLines.pop();
  if (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') nextLines.pop();
  const prevCounts = new Map<string, number>();
  for (const line of prevLines) prevCounts.set(line, (prevCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of nextLines) {
    const left = prevCounts.get(line) ?? 0;
    if (left > 0) prevCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of prevCounts.values()) deletions += left;
  return { additions, deletions };
}

/** The file-level diff between two commits' trees (base -> head). */
function diffCommits(repo: Repo, baseOid: string, headOid: string): PullFile[] {
  const base = commitFiles(repo, baseOid);
  const head = commitFiles(repo, headOid);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    if (b === undefined && h !== undefined) {
      const blob = repo.objects.get(h.oid);
      const additions = blob === undefined ? 0 : lineCount(blob.data.toString('utf8'));
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const blob = repo.objects.get(b.oid);
      const deletions = blob === undefined ? 0 : lineCount(blob.data.toString('utf8'));
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const prev = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const next = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(prev, next);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/** Build a tree object from a flat path -> blob map, creating intermediate trees. */
function buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Store an object, answering its id. */
function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/**
 * Commit one file change on a branch: write the blob, rebuild the tree, create the
 * commit and move the branch. Answers the new commit id (or null when the branch
 * does not exist and no parent was given for a first commit... a first commit is
 * created when `parent` is null).
 */
function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): string | null {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  const files = tip === null ? new Map<string, { oid: string; mode: string }>() : commitFiles(repo, tip);
  if (content === null) {
    if (!files.has(path)) return null;
    files.delete(path);
  } else {
    const blobOid = putObject(repo, 'blob', content);
    files.set(path, { oid: blobOid, mode: '100644' });
  }
  const treeOid = buildTreeFromFiles(repo, files);
  const commit = buildCommit({
    tree: treeOid,
    parents: tip === null ? [] : [tip],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: SERVER_IDENTITY,
    committer: SERVER_IDENTITY,
    timestamp: FIXED_EPOCH_SEC,
  });
  const commitOid = putObject(repo, 'commit', commit);
  repo.refs.set(ref, commitOid);
  repo.packCache.clear();
  return commitOid;
}

/**
 * Whether merging `headTip` into `baseTip` would conflict: a file the head changed
 * (against the merge base) that the base also changed differently.
 */
function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const baseFiles = commitFiles(repo, base);
  const tipFiles = commitFiles(repo, baseTip);
  const headFiles = commitFiles(repo, headTip);
  const changed = diffCommits(repo, base, headTip);
  for (const file of changed) {
    const atBase = baseFiles.get(file.filename)?.oid ?? null;
    const atTip = tipFiles.get(file.filename)?.oid ?? null;
    const atHead = headFiles.get(file.filename)?.oid ?? null;
    if (atTip !== atBase && atHead !== atBase && atHead !== atTip) return true;
  }
  return false;
}

/**
 * Squash-merge a pull request: one commit on the base branch whose tree is the base
 * tree with the head's changes applied. Answers the merge commit id, or null on conflict.
 */
function squashMerge(repo: Repo, pull: Pull): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return null;
  if (mergeConflicts(repo, baseTip, headTip)) return null;
  const base = mergeBase(repo, baseTip, headTip);
  const files = commitFiles(repo, baseTip);
  if (base !== null) {
    for (const file of diffCommits(repo, base, headTip)) {
      if (file.status === 'removed') files.delete(file.filename);
      else {
        const headFiles = commitFiles(repo, headTip);
        const entry = headFiles.get(file.filename);
        if (entry !== undefined) files.set(file.filename, entry);
      }
    }
  }
  const treeOid = buildTreeFromFiles(repo, files);
  const commit = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    message: `Merge pull request #${pull.number} from ${pull.headRef}\n`,
    author: SERVER_IDENTITY,
    committer: SERVER_IDENTITY,
    timestamp: FIXED_EPOCH_SEC,
  });
  const commitOid = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  repo.packCache.clear();
  return commitOid;
}

// --- serializers ---------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER.login ? VIEWER.id : 1000, type: 'User' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repoKey(repo.owner, repo.name),
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    git_url: `/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: globalId('Label', String(label.id)), name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.userLogin),
    assignee: null,
    assignees: [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    locked: false,
    author_association: 'OWNER',
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updatedAt: comment.updatedAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull),
    mergeable_state: pullMergeable(repo, pull).toLowerCase(),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, user: userJson(repo.owner) },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, user: userJson(repo.owner) },
    user: userJson(pull.userLogin),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    draft: false,
    locked: false,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    commits: 1,
    additions: pull.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: pull.files.reduce((sum, file) => sum + file.deletions, 0),
    changed_files: pull.files.length,
  };
}

/** A pull request's mergeability, computed live from the branches. */
function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  return mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

let requestCounter = 0;

interface HttpContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  search: string;
  query: Map<string, string>;
  segments: string[];
  body: Buffer;
}

/** Read the whole request body (up to 64 MiB). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(ctx: HttpContext, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const buffer = Buffer.from(text, 'utf8');
  sendBuffer(ctx, status, buffer, JSON_TYPE, headers);
}

function sendBuffer(ctx: HttpContext, status: number, buffer: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  requestCounter += 1;
  const all: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(buffer.length),
    'x-github-request-id': `req-${requestCounter}`,
    ...headers,
  };
  try {
    ctx.res.writeHead(status, all);
    ctx.res.end(buffer);
  } catch {
    // The peer went away; nothing to write to.
  }
}

function sendNoContent(ctx: HttpContext, status: number): void {
  requestCounter += 1;
  try {
    ctx.res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': `req-${requestCounter}` });
    ctx.res.end();
  } catch {
    // The peer went away.
  }
}

function sendError(ctx: HttpContext, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** Parse a JSON request body; null when the body is empty, `false` when it is malformed. */
function parseJsonBody(ctx: HttpContext): unknown | null | false {
  if (ctx.body.length === 0) return null;
  try {
    return JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    return false;
  }
}

/** The bearer token the request carries, or null. */
function bearerToken(ctx: HttpContext): string | null {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : match[1]!;
}

/** Whether this request is authenticated (the token, when one is configured). */
function isAuthenticated(ctx: HttpContext): boolean {
  if (SHOP_TOKEN === '') return true;
  const token = bearerToken(ctx);
  return token !== null && token === SHOP_TOKEN;
}

function requireAuth(ctx: HttpContext): boolean {
  if (isAuthenticated(ctx)) return true;
  sendError(ctx, 401, 'Requires authentication');
  return false;
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

/** The v0/v2 capabilities the upload-pack advertisement carries. */
const UPLOAD_V0_CAPS =
  'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=forge/1.0 object-format=sha1';
const RECEIVE_V0_CAPS =
  'symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0 object-format=sha1';

/** The refs of a repository, sorted: HEAD's target first, then heads, then tags. */
function sortedRefNames(repo: Repo): string[] {
  const names = [...repo.refs.keys()];
  names.sort((a, b) => {
    const rank = (name: string): number => (name === `refs/heads/${repo.defaultBranch}` ? 0 : name.startsWith('refs/heads/') ? 1 : 2);
    return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  });
  return names;
}

/** The peeled commit of an annotated tag object (or the oid itself). */
function peelTag(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

function handleInfoRefs(ctx: HttpContext, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const owner = ctx.segments[0]!;
  const repoName = ctx.segments[1]!.replace(/\.git$/, '');
  const repo = findRepo(owner, repoName);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const serviceParam = ctx.query.get('service') ?? '';
  if (serviceParam !== service) {
    sendError(ctx, 400, 'Invalid service');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  const contentType = `application/x-${service}-advertisement`;
  if (wantsV2) {
    const body = pktLines([
      `# service=${service}\n`,
      'flush',
      'version 2\n',
      'agent=forge/1.0\n',
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done filter\n',
      'object-format=sha1\n',
      'flush',
    ]);
    sendBuffer(ctx, 200, body, contentType);
    return;
  }
  // v0: the service preamble, then one line per ref (capabilities on the first).
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headLine = headOid === undefined ? `${ZERO_OID} HEAD\0${caps}\n` : `${headOid} HEAD\0${caps}\n`;
    lines.push(headLine);
    for (const name of sortedRefNames(repo)) {
      const oid = repo.refs.get(name)!;
      lines.push(`${oid} ${name}\n`);
      const peeled = peelTag(repo, oid);
      if (peeled !== null) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  lines.push('flush');
  sendBuffer(ctx, 200, pktLines(lines), contentType);
}

interface LsRef {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

/** The refs ls-refs reports (HEAD first when unfiltered, then heads, then tags). */
function lsRefsList(repo: Repo, prefixes: readonly string[]): LsRef[] {
  const out: LsRef[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (headOid === undefined) out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
    else out.push({ oid: headOid, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  }
  for (const name of sortedRefNames(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    const peeled = peelTag(repo, oid);
    out.push(peeled === null ? { oid, name } : { oid, name, peeled });
  }
  return out;
}

/** Handle a v2 ls-refs or fetch command sent to git-upload-pack. */
function handleUploadPack(ctx: HttpContext): void {
  const owner = ctx.segments[0]!;
  const repoName = ctx.segments[1]!.replace(/\.git$/, '');
  const repo = findRepo(owner, repoName);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const { packets } = decodePktLines(ctx.body);
  const lines = pktTextLines(packets);
  const commandLine = lines[0] ?? '';
  if (commandLine.startsWith('command=ls-refs')) {
    const prefixes: string[] = [];
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text === '') continue;
      if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    }
    const refs = lsRefsList(repo, prefixes);
    const out: (string | 'flush')[] = [];
    for (const ref of refs) {
      if (ref.unborn === true) {
        out.push(`unborn ${ref.name}${ref.symrefTarget !== undefined ? ` symref-target:${ref.symrefTarget}` : ''}\n`);
      } else {
        let line = `${ref.oid} ${ref.name}`;
        if (ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
        if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
        out.push(`${line}\n`);
      }
    }
    out.push('flush');
    sendBuffer(ctx, 200, pktLines(out), 'application/x-git-upload-pack-result');
    return;
  }
  if (commandLine.startsWith('command=fetch')) {
    handleFetchV2(ctx, repo, lines);
    return;
  }
  sendError(ctx, 400, 'Unknown command');
}

/** The commits a fetch includes: BFS from `wants`, depth-limited, minus what the client holds. */
/** What the client already holds: the closure of its haves, stopping at shallow
 *  boundaries — a shallow commit's own objects are held, its parents are not. */
function collectHeld(repo: Repo, haves: readonly string[], shallowLines: readonly string[]): Set<string> {
  const shallowSet = new Set(shallowLines);
  const held = new Set<string>();
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const addTree = (treeOid: string): void => {
    try {
      for (const oid of collectReachable([treeOid], lookup)) held.add(oid);
    } catch {
      // A missing tree contributes nothing.
    }
  };
  const stack: string[] = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      held.add(oid);
      const view = parseCommit(object.data);
      addTree(view.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of view.parents) {
          if (shallowSet.has(parent)) {
            // The client holds this boundary commit and its tree, not its history.
            const parentObject = lookup(parent);
            if (parentObject !== undefined && parentObject.type === 'commit') {
              held.add(parent);
              addTree(parseCommit(parentObject.data).tree);
            }
          } else {
            stack.push(parent);
          }
        }
      }
    } else if (object.type === 'tag') {
      held.add(oid);
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      addTree(oid);
    } else {
      held.add(oid);
    }
  }
  return held;
}

function fetchPlan(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  shallowLines: readonly string[],
): { commits: string[]; shallow: string[]; unshallow: string[]; held: Set<string>; extraObjects: string[] } {
  const held = collectHeld(repo, haves, shallowLines);
  // Resolve wants to commits; tag wants also contribute the tag object itself.
  const extraObjects: string[] = [];
  const commitWants: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      extraObjects.push(want);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') commitWants.push(target);
      else if (targetObject !== undefined) extraObjects.push(target);
    } else if (object.type === 'commit') {
      commitWants.push(want);
    } else {
      extraObjects.push(want);
    }
  }
  // BFS by generation: depth 1 is the wants themselves.
  const depths = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of commitWants) {
    if (!depths.has(want)) {
      depths.set(want, 1);
      queue.push({ oid: want, depth: 1 });
    }
  }
  const commits: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const object = repo.objects.get(current.oid);
    if (object === undefined || object.type !== 'commit') continue;
    commits.push(current.oid);
    if (depth !== null && current.depth >= depth) continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!depths.has(parent)) {
        depths.set(parent, current.depth + 1);
        queue.push({ oid: parent, depth: current.depth + 1 });
      }
    }
  }
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of commits) {
      if (depths.get(oid) !== depth) continue;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit' && parseCommit(object.data).parents.length > 0) shallow.push(oid);
    }
  }
  return { commits, shallow, unshallow: [], held, extraObjects };
}

/** The pack for a fetch: the included commits plus their own trees/blobs only
 *  (never the ancestors of a depth-limited commit), plus any tag objects the
 *  client asked for — minus what the client already holds. */
function fetchPack(repo: Repo, plan: ReturnType<typeof fetchPlan>): Buffer {
  const wanted = new Set<string>(plan.extraObjects);
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const commitOid of plan.commits) {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') continue;
    wanted.add(commitOid);
    try {
      for (const oid of collectReachable([parseCommit(object.data).tree], lookup)) wanted.add(oid);
    } catch {
      // A missing tree contributes nothing.
    }
  }
  for (const oid of plan.held) wanted.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of [...wanted].sort()) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return writePack(objects);
}

/** Cache key for a fetch pack. */
function fetchCacheKey(wants: readonly string[], haves: readonly string[], depth: number | null, shallow: readonly string[]): string {
  return `w:${[...wants].sort().join(',')}|h:${[...haves].sort().join(',')}|d:${depth ?? ''}|s:${[...shallow].sort().join(',')}`;
}

function handleFetchV2(ctx: HttpContext, repo: Repo, lines: readonly string[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const plan = fetchPlan(repo, wants, haves, depth, shallow);
  // The new boundary: commits at exactly the requested depth; the old boundary
  // commits that are now fully included are unshallow.
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const old of shallow) {
      if (plan.commits.includes(old) && !plan.shallow.includes(old)) unshallow.push(old);
    }
  }
  const cacheKey = fetchCacheKey(wants, haves, depth, shallow);
  let pack = repo.packCache.get(cacheKey);
  if (pack === undefined) {
    pack = fetchPack(repo, plan);
    if (repo.packCache.size > 64) repo.packCache.clear();
    repo.packCache.set(cacheKey, pack);
  }
  const out: Buffer[] = [];
  if (haves.length > 0) {
    out.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const have of haves) {
      const object = repo.objects.get(have);
      if (object === undefined || object.type !== 'commit') continue;
      let common = false;
      for (const want of wants) {
        if (isAncestor(repo, have, want)) {
          common = true;
          break;
        }
      }
      if (common) {
        out.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (acked) out.push(pktLine('ready\n'));
    else out.push(pktLine('NAK\n'));
    out.push(pktDelim());
  }
  if (plan.shallow.length > 0 || unshallow.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(pktDelim());
  }
  out.push(pktLine('packfile\n'));
  // Sideband band 1, chunked so no pkt-line exceeds the 65520-byte frame.
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    out.push(pktLine(framed));
  }
  out.push(pktFlush());
  sendBuffer(ctx, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}

/** Handle a v0 fetch (two sections: wants, then haves + done). */
function handleFetchV0(ctx: HttpContext, repo: Repo): void {
  const { packets } = decodePktLines(ctx.body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const plan = fetchPlan(repo, wants, haves, depth, shallow);
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const old of shallow) {
      if (plan.commits.includes(old) && !plan.shallow.includes(old)) unshallow.push(old);
    }
  }
  const pack = fetchPack(repo, plan);
  const out: Buffer[] = [];
  let acked = false;
  if (haves.length > 0) {
    for (const have of haves) {
      const object = repo.objects.get(have);
      if (object === undefined || object.type !== 'commit') continue;
      for (const want of wants) {
        if (isAncestor(repo, have, want)) {
          out.push(pktLine(`ACK ${have}\n`));
          acked = true;
          break;
        }
      }
    }
    if (!acked) out.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  out.push(pktFlush());
  sendBuffer(ctx, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}

/** Handle POST /{owner}/{repo}.git/git-upload-pack (v2 when Git-Protocol says so, else v0 fetch). */
function handleUploadPackPost(ctx: HttpContext): void {
  const owner = ctx.segments[0]!;
  const repoName = ctx.segments[1]!.replace(/\.git$/, '');
  const repo = findRepo(owner, repoName);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const { packets } = decodePktLines(ctx.body);
  const lines = pktTextLines(packets);
  const first = lines[0] ?? '';
  if (first.startsWith('command=')) {
    handleUploadPack(ctx);
    return;
  }
  if (first.startsWith('want ') || lines.some((line) => line.startsWith('want '))) {
    handleFetchV0(ctx, repo);
    return;
  }
  sendError(ctx, 400, 'Unknown upload-pack request');
}

// --- receive-pack ---------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(ctx: HttpContext): void {
  const owner = ctx.segments[0]!;
  const repoName = ctx.segments[1]!.replace(/\.git$/, '');
  const repo = findRepo(owner, repoName);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const { packets, next } = decodePktLines(ctx.body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const head = nul < 0 ? text : text.slice(0, nul);
    if (nul >= 0 && commands.length === 0) {
      const caps = text.slice(nul + 1).replace(/\n$/, '').split(' ');
      sideband = caps.includes('side-band-64k');
    }
    const parts = head.replace(/\n$/, '').split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) {
    sendError(ctx, 400, 'No push commands');
    return;
  }
  // Unpack the pack (everything after the command flush), storing every object.
  const packBytes = ctx.body.subarray(next);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error: no packfile';
    } else {
      try {
        const objects = readPack(Buffer.from(packBytes), (oid) => repo.objects.get(oid));
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = `unpacker error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  // Validate and apply each command, reporting per ref.
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = true;
      let reason = '';
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          ok = false;
          reason = 'remote ref does not exist';
        } else if (command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else {
        const object = repo.objects.get(command.newOid);
        if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
          ok = false;
          reason = 'missing object';
        } else if (command.oldOid === ZERO_OID) {
          if (current !== undefined) {
            ok = false;
            reason = 'non-fast-forward';
          }
        } else if (current === undefined || command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (object.type === 'commit' && !isAncestor(repo, current, command.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      }
      if (ok) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        repo.packCache.clear();
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} ${reason}\n`);
      }
    }
  }
  const report = pktLines(reportLines.map((line) => line as string));
  let body: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    for (const line of reportLines) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])));
    }
    // The status stream inside band 1 ends with its own flush pkt-line;
    // without it the client keeps reading and reports a hang-up.
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktFlush()])));
    parts.push(pktFlush());
    body = Buffer.concat(parts);
  } else {
    body = Buffer.concat([report, pktFlush()]);
  }
  sendBuffer(ctx, 200, body, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// REST v3 (/api/v3)
// ---------------------------------------------------------------------------

/** The repo a REST route names, or null (with the error already sent). */
function restRepo(ctx: HttpContext): Repo | null {
  const owner = ctx.segments[3]!;
  const name = ctx.segments[4]!;
  if (owner !== VIEWER.login) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  const repo = findRepo(owner, name);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** A page of a list, with the Link header when more pages follow. */
function sendList(ctx: HttpContext, items: unknown[], total: number, page: number, perPage: number, basePath: string): void {
  const headers: Record<string, string> = {};
  if (page * perPage < total) {
    const origin = `http://${ctx.req.headers.host ?? 'localhost'}`;
    headers.link = `<${origin}${basePath}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  }
  sendJson(ctx, 200, items, headers);
}

function pageOf(query: Map<string, string>): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Resolve a ref name or oid to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const headed = repo.refs.get(`refs/heads/${ref}`);
  if (headed !== undefined) return headed;
  return null;
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const view = object === undefined ? null : parseCommit(object.data);
  const authorLine = view?.author ?? '';
  const committerLine = view?.committer ?? '';
  const authorMatch = /^(.*) <(.*)> (\d+) \+0000$/.exec(authorLine);
  const committerMatch = /^(.*) <(.*)> (\d+) \+0000$/.exec(committerLine);
  const isoOf = (epoch: string | undefined): string => {
    const sec = Number(epoch ?? FIXED_EPOCH_SEC);
    return new Date(sec * 1000).toISOString();
  };
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      // The stored object ends its message with a newline (git convention);
      // the API view reports the message without it.
      message: (view?.message ?? '').replace(/\n$/, ''),
      author: {
        name: authorMatch?.[1] ?? '',
        email: authorMatch?.[2] ?? '',
        date: isoOf(authorMatch?.[3]),
      },
      committer: {
        name: committerMatch?.[1] ?? '',
        email: committerMatch?.[2] ?? '',
        date: isoOf(committerMatch?.[3]),
      },
      tree: { sha: view?.tree ?? '' },
    },
    author: null,
    committer: null,
    parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

function handleRest(ctx: HttpContext): void {
  const seg = ctx.segments;
  const method = ctx.method;
  // The API root and meta are public; everything else needs the token.
  if (method === 'GET' && (ctx.pathname === '/api/v3' || ctx.pathname === '/api/v3/')) {
    sendJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && ctx.pathname === '/api/v3/meta') {
    sendJson(ctx, 200, { installed_version: VERSION });
    return;
  }
  if (!requireAuth(ctx)) return;

  if (method === 'GET' && ctx.pathname === '/api/v3/user') {
    sendJson(ctx, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: globalId('User', VIEWER.login),
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      avatar_url: '',
      html_url: `/${VIEWER.login}`,
      url: '/api/v3/user',
    });
    return;
  }

  if (seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageOf(ctx.query);
      const all = listRepos(VIEWER.login);
      sendList(ctx, paginate(all, page, perPage).map(repoJson), all.length, page, perPage, '/api/v3/user/repos');
      return;
    }
    if (method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === false) {
        sendError(ctx, 400, 'Invalid JSON');
        return;
      }
      const input = (body ?? {}) as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') {
        sendError(ctx, 422, 'Validation Failed: name is required');
        return;
      }
      if (findRepo(VIEWER.login, name) !== undefined) {
        sendError(ctx, 422, 'Repository already exists');
        return;
      }
      const repo = createRepo(
        VIEWER.login,
        name,
        typeof input.description === 'string' ? input.description : '',
        input.private === true,
      );
      sendJson(ctx, 201, repoJson(repo));
      return;
    }
  }

  if (seg[2] === 'repos' && seg.length >= 5) {
    handleRestRepo(ctx);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function handleRestRepo(ctx: HttpContext): void {
  const seg = ctx.segments;
  const method = ctx.method;
  const owner = seg[3]!;
  const name = seg[4]!;
  const rest = seg.slice(5);

  // DELETE /repos/{o}/{r} (no body needed).
  if (method === 'DELETE' && rest.length === 0) {
    if (owner !== VIEWER.login) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (!deleteRepo(owner, name)) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendNoContent(ctx, 204);
    return;
  }

  const repo = restRepo(ctx);
  if (repo === null) return;

  // GET / PATCH /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(ctx);
      if (body === false) {
        sendError(ctx, 400, 'Invalid JSON');
        return;
      }
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      repo.updatedAt = FIXED_ISO;
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const head = rest[0]!;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = sortedRefNames(repo)
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(ref)!, url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(ref)!}` },
          protected: false,
        }));
      sendJson(ctx, 200, branches);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const ref = `refs/heads/${rest.slice(1).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, {
        name: rest.slice(1).join('/'),
        commit: { sha: oid, url: `/api/v3/repos/${owner}/${name}/commits/${oid}` },
        protected: false,
      });
      return;
    }
  }

  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const refParam = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, refParam);
    if (tip === null) {
      sendJson(ctx, 200, []);
      return;
    }
    const commits = walkCommits(repo, tip).map((oid) => commitJson(repo, oid));
    const { page, perPage } = pageOf(ctx.query);
    sendJson(ctx, 200, paginate(commits, page, perPage));
    return;
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = parseJsonBody(ctx);
      if (body === false) {
        sendError(ctx, 400, 'Invalid JSON');
        return;
      }
      const input = (body ?? {}) as Record<string, unknown>;
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha)) {
        sendError(ctx, 422, 'Validation Failed');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(ctx, 422, 'Reference already exists');
        return;
      }
      if (!repo.objects.has(sha)) {
        sendError(ctx, 422, 'Validation Failed: invalid sha');
        return;
      }
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      const object = repo.objects.get(sha)!;
      sendJson(ctx, 201, {
        ref,
        node_id: globalId('Ref', `${owner}/${name}/${ref}`),
        url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`,
        object: { sha, type: object.type, url: `/api/v3/repos/${owner}/${name}/git/${object.type}s/${sha}` },
      });
      return;
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      const object = repo.objects.get(oid)!;
      sendJson(ctx, 200, {
        ref: `refs/heads/${branch}`,
        node_id: globalId('Ref', `${owner}/${name}/refs/heads/${branch}`),
        url: `/api/v3/repos/${owner}/${name}/git/refs/heads/${branch}`,
        object: { sha: oid, type: object.type, url: `/api/v3/repos/${owner}/${name}/git/${object.type}s/${oid}` },
      });
      return;
    }
  }

  if (head === 'contents') {
    handleContents(ctx, repo);
    return;
  }

  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = parseJsonBody(ctx);
      if (body === false) {
        sendError(ctx, 400, 'Invalid JSON');
        return;
      }
      const input = (body ?? {}) as Record<string, unknown>;
      const labelName = typeof input.name === 'string' ? input.name : '';
      if (labelName === '') {
        sendError(ctx, 422, 'Validation Failed: name is required');
        return;
      }
      let label = repo.labels.get(labelName);
      if (label === undefined) {
        label = {
          id: nextLabelId++,
          name: labelName,
          color: typeof input.color === 'string' ? input.color : 'ededed',
          description: typeof input.description === 'string' ? input.description : '',
        };
        repo.labels.set(labelName, label);
      }
      sendJson(ctx, 201, labelJson(label));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(ctx, 200, [...repo.labels.values()].map(labelJson));
      return;
    }
  }

  if (head === 'issues') {
    handleIssues(ctx, repo);
    return;
  }

  if (head === 'pulls') {
    handlePulls(ctx, repo);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// --- contents ---------------------------------------------------------------

function handleContents(ctx: HttpContext, repo: Repo): void {
  const seg = ctx.segments;
  const method = ctx.method;
  const path = seg.slice(6).join('/');
  const branch = ctx.query.get('ref') ?? ctx.query.get('branch') ?? repo.defaultBranch;
  const tip = resolveRef(repo, branch);

  if (method === 'GET') {
    if (tip === null) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (path === '') {
      sendJson(ctx, 200, directoryListing(repo, tip, ''));
      return;
    }
    const files = commitFiles(repo, tip);
    const blobOid = files.get(path)?.oid ?? null;
    if (blobOid !== null) {
      const blob = repo.objects.get(blobOid)!;
      sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: blob.data.toString('base64'),
        sha: blobOid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
        download_url: null,
      });
      return;
    }
    // A directory: entries directly under `path`.
    const prefix = `${path}/`;
    const hasChildren = [...files.keys()].some((key) => key.startsWith(prefix));
    if (hasChildren) {
      sendJson(ctx, 200, directoryListing(repo, tip, path));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (method === 'PUT') {
    const body = parseJsonBody(ctx);
    if (body === false) {
      sendError(ctx, 400, 'Invalid JSON');
      return;
    }
    const input = (body ?? {}) as Record<string, unknown>;
    const content = typeof input.content === 'string' ? input.content : '';
    const message = typeof input.message === 'string' ? input.message : 'Update file';
    const targetBranch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
    const targetTip = resolveRef(repo, targetBranch);
    const files = targetTip === null ? new Map() : commitFiles(repo, targetTip);
    const existing = files.get(path)?.oid ?? null;
    const sha = typeof input.sha === 'string' ? input.sha : null;
    if (existing !== null) {
      if (sha === null || sha.toLowerCase() !== existing.toLowerCase()) {
        sendError(ctx, 409, 'Conflict: sha does not match the current file');
        return;
      }
    }
    let contentBytes: Buffer;
    try {
      contentBytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      sendError(ctx, 422, 'Validation Failed: content is not valid base64');
      return;
    }
    const blobOid = putObject(repo, 'blob', contentBytes);
    // Create the branch from the default tip when it does not exist yet.
    if (targetTip === null && targetBranch !== repo.defaultBranch) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) repo.refs.set(`refs/heads/${targetBranch}`, defaultTip);
    }
    const commitOid = commitFile(repo, targetBranch, path, contentBytes, message);
    if (commitOid === null) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, existing === null ? 201 : 200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: contentBytes.length,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `/${repo.owner}/${repo.name}/blob/${targetBranch}/${path}`,
        git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
        download_url: null,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commitOid, message, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitOid}` },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = parseJsonBody(ctx);
    if (body === false) {
      sendError(ctx, 400, 'Invalid JSON');
      return;
    }
    const input = (body ?? {}) as Record<string, unknown>;
    const message = typeof input.message === 'string' ? input.message : 'Delete file';
    const targetBranch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
    const targetTip = resolveRef(repo, targetBranch);
    if (targetTip === null) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const files = commitFiles(repo, targetTip);
    const existing = files.get(path)?.oid ?? null;
    if (existing === null) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const sha = typeof input.sha === 'string' ? input.sha : null;
    if (sha !== null && sha.toLowerCase() !== existing.toLowerCase()) {
      sendError(ctx, 409, 'Conflict: sha does not match the current file');
      return;
    }
    const commitOid = commitFile(repo, targetBranch, path, null, message);
    if (commitOid === null) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, { commit: { sha: commitOid, message, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitOid}` } });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

/** The directory listing of `dir` ('' for the root) at a commit. */
function directoryListing(repo: Repo, tip: string, dir: string): Record<string, unknown>[] {
  const files = commitFiles(repo, tip);
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const blob = repo.objects.get(entry.oid);
      entries.set(rest, { type: 'file', oid: entry.oid, size: blob?.data.length ?? 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) {
        // The subtree oid: walk the tree to find it.
        const subtree = findSubtreeOid(repo, tip, dir === '' ? name : `${dir}/${name}`);
        entries.set(name, { type: 'dir', oid: subtree ?? ZERO_OID, size: 0 });
      }
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const [name, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.push({
      type: entry.type,
      size: entry.size,
      name,
      path: dir === '' ? name : `${dir}/${name}`,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${dir === '' ? name : `${dir}/${name}`}`,
      html_url: `/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${dir === '' ? name : `${dir}/${name}`}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.oid}`,
      download_url: entry.type === 'file' ? `/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${dir === '' ? name : `${dir}/${name}`}` : null,
    });
  }
  return out;
}

/** The tree oid of a directory path at a commit, or null. */
function findSubtreeOid(repo: Repo, tip: string, dir: string): string | null {
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  for (const segment of dir.split('/')) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

// --- issues ---------------------------------------------------------------

function createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const id = nextIssueId++;
  const number = repo.nextNumber++;
  const issue: Issue = {
    id,
    nodeId: globalId('Issue', `${repo.owner}/${repo.name}/${number}`),
    number,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    userLogin: VIEWER.login,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    closedAt: null,
    jsonCache: null,
  };
  repo.issues.set(number, issue);
  return issue;
}

function issueJsonCached(repo: Repo, issue: Issue): Buffer {
  if (issue.jsonCache === null) {
    issue.jsonCache = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
  }
  return issue.jsonCache;
}

function handleIssues(ctx: HttpContext, repo: Repo): void {
  const seg = ctx.segments;
  const method = ctx.method;
  const rest = seg.slice(5);

  if (rest.length === 1 && method === 'POST') {
    const body = parseJsonBody(ctx);
    if (body === false) {
      sendError(ctx, 400, 'Invalid JSON');
      return;
    }
    const input = (body ?? {}) as Record<string, unknown>;
    const title = typeof input.title === 'string' ? input.title : '';
    if (title === '') {
      sendError(ctx, 422, 'Validation Failed: title is required');
      return;
    }
    const labelNames = Array.isArray(input.labels) ? input.labels.filter((entry): entry is string => typeof entry === 'string') : [];
    const labels: Label[] = [];
    for (const labelName of labelNames) {
      const label = repo.labels.get(labelName);
      if (label === undefined) {
        sendError(ctx, 422, `Validation Failed: label "${labelName}" does not exist`);
        return;
      }
      labels.push(label);
    }
    const issue = createIssue(repo, title, typeof input.body === 'string' ? input.body : '', labels);
    sendBuffer(ctx, 201, issueJsonCached(repo, issue), JSON_TYPE);
    return;
  }

  if (rest.length === 1 && method === 'GET') {
    const state = (ctx.query.get('state') ?? 'open').toLowerCase();
    const sort = ctx.query.get('sort') ?? 'created';
    const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
    void sort;
    let issues = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    const { page, perPage } = pageOf(ctx.query);
    const sliced = paginate(issues, page, perPage);
    sendJson(ctx, 200, sliced.map((issue) => issueJson(repo, issue)));
    return;
  }

  if (rest.length === 2) {
    const number = Number(rest[1]);
    const issue = repo.issues.get(number);
    if (issue === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendBuffer(ctx, 200, issueJsonCached(repo, issue), JSON_TYPE);
      return;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(ctx);
      if (body === false) {
        sendError(ctx, 400, 'Invalid JSON');
        return;
      }
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'open' || input.state === 'closed') {
        issue.state = input.state;
        issue.closedAt = input.state === 'closed' ? FIXED_ISO : null;
      }
      if (Array.isArray(input.labels)) {
        const labels: Label[] = [];
        for (const labelName of input.labels.filter((entry): entry is string => typeof entry === 'string')) {
          const label = repo.labels.get(labelName);
          if (label !== undefined) labels.push(label);
        }
        issue.labels = labels;
      }
      issue.updatedAt = FIXED_ISO;
      issue.jsonCache = null;
      sendBuffer(ctx, 200, issueJsonCached(repo, issue), JSON_TYPE);
      return;
    }
  }

  if (rest.length === 3 && rest[2] === 'comments') {
    const number = Number(rest[1]);
    const issue = repo.issues.get(number);
    if (issue === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === false) {
        sendError(ctx, 400, 'Invalid JSON');
        return;
      }
      const input = (body ?? {}) as Record<string, unknown>;
      const commentBody = typeof input.body === 'string' ? input.body : '';
      const id = repo.nextCommentId++;
      const comment: Comment = {
        id,
        nodeId: globalId('IssueComment', `${repo.owner}/${repo.name}/${number}/${id}`),
        body: commentBody,
        userLogin: VIEWER.login,
        createdAt: FIXED_ISO,
        updatedAt: FIXED_ISO,
      };
      issue.comments.push(comment);
      issue.jsonCache = null;
      sendJson(ctx, 201, commentJson(repo, issue, comment));
      return;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
      return;
    }
  }

  sendError(ctx, 404, 'Not Found');
}

// --- pull requests ----------------------------------------------------------

function createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  if (headTip === undefined || baseTip === undefined) return null;
  const id = nextIssueId++;
  const number = repo.nextNumber++;
  const pull: Pull = {
    id,
    nodeId: globalId('PullRequest', `${repo.owner}/${repo.name}/${number}`),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    headSha: headTip,
    baseRef,
    baseSha: baseTip,
    userLogin: VIEWER.login,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    closedAt: null,
    files: diffCommits(repo, baseTip, headTip),
  };
  repo.pulls.set(number, pull);
  return pull;
}

function handlePulls(ctx: HttpContext, repo: Repo): void {
  const seg = ctx.segments;
  const method = ctx.method;
  const rest = seg.slice(5);

  if (rest.length === 1 && method === 'POST') {
    const body = parseJsonBody(ctx);
    if (body === false) {
      sendError(ctx, 400, 'Invalid JSON');
      return;
    }
    const input = (body ?? {}) as Record<string, unknown>;
    const title = typeof input.title === 'string' ? input.title : '';
    const head = typeof input.head === 'string' ? input.head : '';
    const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
    if (title === '' || head === '') {
      sendError(ctx, 422, 'Validation Failed: title and head are required');
      return;
    }
    if (repo.refs.get(`refs/heads/${head}`) === undefined) {
      sendError(ctx, 422, `Validation Failed: head branch "${head}" does not exist`);
      return;
    }
    if (repo.refs.get(`refs/heads/${base}`) === undefined) {
      sendError(ctx, 422, `Validation Failed: base branch "${base}" does not exist`);
      return;
    }
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        sendError(ctx, 422, 'Validation Failed: a pull request already exists for this head');
        return;
      }
    }
    const pull = createPull(repo, title, typeof input.body === 'string' ? input.body : '', head, base);
    if (pull === null) {
      sendError(ctx, 422, 'Validation Failed');
      return;
    }
    sendJson(ctx, 201, pullJson(repo, pull));
    return;
  }

  if (rest.length === 1 && method === 'GET') {
    const state = (ctx.query.get('state') ?? 'open').toLowerCase();
    let pulls = [...repo.pulls.values()];
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    pulls.sort((a, b) => b.number - a.number);
    const { page, perPage } = pageOf(ctx.query);
    sendJson(ctx, 200, paginate(pulls, page, perPage).map((pull) => pullJson(repo, pull)));
    return;
  }

  if (rest.length === 2) {
    const number = Number(rest[1]);
    const pull = repo.pulls.get(number);
    if (pull === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, pullJson(repo, pull));
      return;
    }
  }

  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
    const number = Number(rest[1]);
    const pull = repo.pulls.get(number);
    if (pull === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const files = pull.files.map((file) => {
      const blobOid = headTip === undefined ? null : treePathBlob(repo, headTip, file.filename);
      return {
        sha: blobOid ?? ZERO_OID,
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: `/${repo.owner}/${repo.name}/blob/${pull.headSha}/${file.filename}`,
        raw_url: `/${repo.owner}/${repo.name}/raw/${pull.headSha}/${file.filename}`,
        contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${file.filename}?ref=${pull.headRef}`,
        patch: null,
      };
    });
    sendJson(ctx, 200, files);
    return;
  }

  if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
    const number = Number(rest[1]);
    const pull = repo.pulls.get(number);
    if (pull === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const body = parseJsonBody(ctx);
    if (body === false) {
      sendError(ctx, 400, 'Invalid JSON');
      return;
    }
    if (pull.state !== 'open') {
      sendError(ctx, 405, 'Pull request is already merged or closed');
      return;
    }
    const mergeSha = squashMerge(repo, pull);
    if (mergeSha === null) {
      sendError(ctx, 405, 'Merge conflict');
      return;
    }
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = mergeSha;
    pull.state = 'closed';
    pull.closedAt = FIXED_ISO;
    pull.updatedAt = FIXED_ISO;
    pull.baseSha = mergeSha;
    sendJson(ctx, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL v4 (/api/graphql)
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null'; value: null }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; value: GqlValue[] }
  | { kind: 'object'; value: Record<string, GqlValue> };

interface GqlFieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}

interface GqlFragmentSelection {
  kind: 'fragment';
  typeCondition: string;
  selections: GqlSelection[];
}

type GqlSelection = GqlFieldSelection | GqlFragmentSelection;

interface GqlVarDef {
  name: string;
  type: string;
  defaultValue: GqlValue | null;
}

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: GqlVarDef[];
  selections: GqlSelection[];
}

interface GqlToken {
  kind: 'punct' | 'name' | 'string' | 'int' | 'float' | 'spread';
  value: string;
}

function gqlTokenize(input: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$!=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u' && i + 5 < input.length) {
            value += String.fromCharCode(Number.parseInt(input.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += esc;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (j < input.length && input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (j < input.length && (input[j] === 'e' || input[j] === 'E')) {
        isFloat = true;
        j += 1;
        if (j < input.length && (input[j] === '+' || input[j] === '-')) j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL: unexpected character ${ch}`);
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: GqlToken[];

  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
  }

  private peek(): GqlToken | undefined {
    return this.tokens[this.pos];
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('GraphQL: unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`GraphQL: expected ${value}`);
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    const first = this.peek();
    if (first !== undefined && first.kind === 'punct' && first.value === '{') {
      return { type: 'query', name: null, varDefs: [], selections: this.parseSelections() };
    }
    const keyword = this.next();
    if (keyword.kind !== 'name' || (keyword.value !== 'query' && keyword.value !== 'mutation')) {
      throw new Error('GraphQL: expected query or mutation');
    }
    const type = keyword.value as 'query' | 'mutation';
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.kind === 'name') {
      name = this.next().value;
    }
    const varDefs: GqlVarDef[] = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        this.expectPunct('$');
        const varName = this.next().value;
        this.expectPunct(':');
        const typeName = this.parseTypeName();
        let defaultValue: GqlValue | null = null;
        if (this.matchPunct('=')) defaultValue = this.parseValue();
        varDefs.push({ name: varName, type: typeName, defaultValue });
      }
    }
    return { type, name, varDefs, selections: this.parseSelections() };
  }

  private parseTypeName(): string {
    let type = '';
    if (this.matchPunct('[')) {
      type = `[${this.parseTypeName()}]`;
    } else {
      type = this.next().value;
    }
    if (this.matchPunct('!')) type += '!';
    return type;
  }

  private parseSelections(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek() !== undefined && this.peek()!.kind === 'punct' && this.peek()!.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.next();
      const on = this.next();
      if (on.kind !== 'name' || on.value !== 'on') throw new Error('GraphQL: expected "on" after ...');
      const typeCondition = this.next().value;
      return { kind: 'fragment', typeCondition, selections: this.parseSelections() };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error('GraphQL: expected field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.matchPunct(':')) {
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, GqlValue> = {};
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        const argName = this.next().value;
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    let selections: GqlSelection[] = [];
    const next = this.peek();
    if (next !== undefined && next.kind === 'punct' && next.value === '{') {
      selections = this.parseSelections();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!(this.peek() !== undefined && this.peek()!.kind === 'punct' && this.peek()!.value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', value: values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (!(this.peek() !== undefined && this.peek()!.kind === 'punct' && this.peek()!.value === '}')) {
        const key = this.next().value;
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', value: fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('GraphQL: unexpected value');
  }
}

/** Resolve a parsed value against the operation variables (defaults included). */
function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>, varDefs: GqlVarDef[]): unknown {
  switch (value.kind) {
    case 'variable': {
      if (variables[value.name] !== undefined) return variables[value.name];
      const def = varDefs.find((entry) => entry.name === value.name);
      return def?.defaultValue === null || def?.defaultValue === undefined ? null : resolveGqlValue(def.defaultValue, variables, varDefs);
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'null':
    case 'enum':
      return value.value;
    case 'list':
      return value.value.map((entry) => resolveGqlValue(entry, variables, varDefs));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.value)) out[key] = resolveGqlValue(entry, variables, varDefs);
      return out;
    }
  }
}

function resolveGqlArgs(field: GqlFieldSelection, variables: Record<string, unknown>, varDefs: GqlVarDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveGqlValue(value, variables, varDefs);
  return out;
}

// --- views (GraphQL shapes over the store) ----------------------------------

/** Store objects behind view records (views must stay free of store references). */
const viewRepos = new WeakMap<Record<string, unknown>, Repo>();
const viewIssues = new WeakMap<Record<string, unknown>, { repo: Repo; issue: Issue }>();
const viewPulls = new WeakMap<Record<string, unknown>, { repo: Repo; pull: Pull }>();

function userView(login: string): Record<string, unknown> {
  const user = USERS_BY_LOGIN.get(login);
  return {
    __typename: 'User',
    id: globalId('User', login),
    databaseId: user?.id ?? 0,
    login,
    name: user?.name ?? login,
    email: user?.email ?? '',
    url: `/${login}`,
  };
}

function branchRefView(repo: Repo, branch: string): Record<string, unknown> {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  return {
    __typename: 'BranchRef',
    name: branch,
    target: oid === undefined ? null : { __typename: 'Commit', oid },
  };
}

function repositoryView(repo: Repo): Record<string, unknown> {
  const view: Record<string, unknown> = {
    __typename: 'Repository',
    id: globalId('Repository', `${repo.owner}/${repo.name}`),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userView(repo.owner),
    description: repo.description,
    isPrivate: repo.private,
    defaultBranchRef: branchRefView(repo, repo.defaultBranch),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `/${repo.owner}/${repo.name}`,
  };
  viewRepos.set(view, repo);
  return view;
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  const view: Record<string, unknown> = {
    __typename: 'Issue',
    id: issue.nodeId,
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: userView(issue.userLogin),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
  viewIssues.set(view, { repo, issue });
  return view;
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  const view: Record<string, unknown> = {
    __typename: 'PullRequest',
    id: pull.nodeId,
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergeable: pullMergeable(repo, pull),
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    author: userView(pull.userLogin),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.closedAt,
    url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
  viewPulls.set(view, { repo, pull });
  return view;
}

function commentView(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    __typename: 'IssueComment',
    id: comment.nodeId,
    databaseId: comment.id,
    body: comment.body,
    author: userView(comment.userLogin),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return {
    __typename: 'Label',
    id: globalId('Label', label.name),
    databaseId: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
  };
}

/** Cursor helpers: cursors are base64 of `cursor:<value>`. */
function encodeCursor(value: string): string {
  return b64encode(`cursor:${value}`);
}

function decodeCursor(cursor: unknown): string | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    return decoded.startsWith('cursor:') ? decoded.slice('cursor:'.length) : null;
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const field = String(orderBy?.field ?? 'CREATED_AT').toUpperCase();
  const direction = String(orderBy?.direction ?? 'DESC').toUpperCase();
  void field;
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = decodeCursor(args.after);
  if (after !== null) {
    const last = Number(after);
    issues = direction === 'ASC' ? issues.filter((issue) => issue.number > last) : issues.filter((issue) => issue.number < last);
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueView(repo, issue)),
    totalCount: repo.issues.size,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? encodeCursor(String(page[0]!.number)) : null,
      endCursor: page.length > 0 ? encodeCursor(String(page[page.length - 1]!.number)) : null,
    },
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let pulls = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const direction = String(orderBy?.direction ?? 'DESC').toUpperCase();
  pulls.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = decodeCursor(args.after);
  if (after !== null) {
    const last = Number(after);
    pulls = direction === 'ASC' ? pulls.filter((pull) => pull.number > last) : pulls.filter((pull) => pull.number < last);
  }
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  const hasNextPage = pulls.length > page.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullView(repo, pull)),
    totalCount: repo.pulls.size,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? encodeCursor(String(page[0]!.number)) : null,
      endCursor: page.length > 0 ? encodeCursor(String(page[page.length - 1]!.number)) : null,
    },
  };
}

function fileConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): Record<string, unknown> {
  const after = decodeCursor(args.after);
  const start = after === null ? 0 : Number(after) + 1;
  const first = typeof args.first === 'number' ? args.first : pull.files.length;
  const page = pull.files.slice(start, start + first);
  const hasNextPage = start + page.length < pull.files.length;
  return {
    __typename: 'PullRequestFileConnection',
    nodes: page.map((file) => ({
      __typename: 'PullRequestFile',
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
    })),
    totalCount: pull.files.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor(String(start)) : null,
      endCursor: page.length > 0 ? encodeCursor(String(start + page.length - 1)) : null,
    },
  };
}

// --- introspection ------------------------------------------------------------

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'labels', 'comments'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url'],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
};

function typeIntrospection(name: string): Record<string, unknown> | null {
  if (INTROSPECTION_FIELDS[name] !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      description: null,
      fields: INTROSPECTION_FIELDS[name]!.map((fieldName) => ({
        name: fieldName,
        description: null,
        args: [],
        type: { kind: 'SCALAR', name: 'String', ofType: null },
      })),
      enumValues: null,
      interfaces: [],
      possibleTypes: null,
    };
  }
  if (INTROSPECTION_ENUMS[name] !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      description: null,
      fields: null,
      enumValues: INTROSPECTION_ENUMS[name]!.map((value) => ({
        name: value,
        description: null,
        isDeprecated: false,
        deprecationReason: null,
      })),
      interfaces: [],
      possibleTypes: null,
    };
  }
  return null;
}

// --- execution ---------------------------------------------------------------

interface GqlError {
  message: string;
}

interface GqlResolve {
  value: unknown;
  typeName: string;
}

/** Resolve one field on a view object. */
function resolveGqlField(
  typeName: string,
  object: Record<string, unknown> | null,
  field: GqlFieldSelection,
  args: Record<string, unknown>,
  errors: GqlError[],
): GqlResolve {
  if (typeName === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { value: userView(VIEWER.login), typeName: 'User' };
      case 'repository': {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = findRepo(owner, name);
        return { value: repo === undefined ? null : repositoryView(repo), typeName: 'Repository' };
      }
      case 'node': {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return { value: null, typeName: 'Node' };
        if (parsed.kind === 'Repository') {
          const repo = findRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
          return { value: repo === undefined ? null : repositoryView(repo), typeName: 'Repository' };
        }
        if (parsed.kind === 'Issue') {
          const repo = findRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
          const issue = repo?.issues.get(Number(parsed.parts[2]));
          return { value: repo === undefined || issue === undefined ? null : issueView(repo, issue), typeName: 'Issue' };
        }
        if (parsed.kind === 'PullRequest') {
          const repo = findRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
          const pull = repo?.pulls.get(Number(parsed.parts[2]));
          return { value: repo === undefined || pull === undefined ? null : pullView(repo, pull), typeName: 'PullRequest' };
        }
        return { value: null, typeName: 'Node' };
      }
      case '__type': {
        const name = String(args.name ?? '');
        return { value: typeIntrospection(name), typeName: '__Type' };
      }
      case '__schema':
        return { value: { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] }, typeName: '__Schema' };
      case 'createIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        if (parsed === null || parsed.kind !== 'Repository') {
          errors.push({ message: 'createIssue: invalid repositoryId' });
          return { value: null, typeName: 'CreateIssuePayload' };
        }
        const repo = findRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
        if (repo === undefined) {
          errors.push({ message: 'createIssue: repository not found' });
          return { value: null, typeName: 'CreateIssuePayload' };
        }
        const issue = createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        return { value: { __typename: 'CreateIssuePayload', issue: issueView(repo, issue) }, typeName: 'CreateIssuePayload' };
      }
      case 'closeIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        if (parsed === null || parsed.kind !== 'Issue') {
          errors.push({ message: 'closeIssue: invalid issueId' });
          return { value: null, typeName: 'CloseIssuePayload' };
        }
        const repo = findRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
        const issue = repo?.issues.get(Number(parsed.parts[2]));
        if (repo === undefined || issue === undefined) {
          errors.push({ message: 'closeIssue: issue not found' });
          return { value: null, typeName: 'CloseIssuePayload' };
        }
        issue.state = 'closed';
        issue.closedAt = FIXED_ISO;
        issue.updatedAt = FIXED_ISO;
        issue.jsonCache = null;
        return { value: { __typename: 'CloseIssuePayload', issue: issueView(repo, issue) }, typeName: 'CloseIssuePayload' };
      }
      case 'createPullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        if (parsed === null || parsed.kind !== 'Repository') {
          errors.push({ message: 'createPullRequest: invalid repositoryId' });
          return { value: null, typeName: 'CreatePullRequestPayload' };
        }
        const repo = findRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
        if (repo === undefined) {
          errors.push({ message: 'createPullRequest: repository not found' });
          return { value: null, typeName: 'CreatePullRequestPayload' };
        }
        const pull = createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        if (pull === null) {
          errors.push({ message: 'createPullRequest: head or base branch does not exist' });
          return { value: null, typeName: 'CreatePullRequestPayload' };
        }
        return { value: { __typename: 'CreatePullRequestPayload', pullRequest: pullView(repo, pull) }, typeName: 'CreatePullRequestPayload' };
      }
      case 'mergePullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        if (parsed === null || parsed.kind !== 'PullRequest') {
          errors.push({ message: 'mergePullRequest: invalid pullRequestId' });
          return { value: null, typeName: 'MergePullRequestPayload' };
        }
        const repo = findRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
        const pull = repo?.pulls.get(Number(parsed.parts[2]));
        if (repo === undefined || pull === undefined) {
          errors.push({ message: 'mergePullRequest: pull request not found' });
          return { value: null, typeName: 'MergePullRequestPayload' };
        }
        if (pull.state !== 'open') {
          errors.push({ message: 'mergePullRequest: pull request is not open' });
          return { value: null, typeName: 'MergePullRequestPayload' };
        }
        const mergeSha = squashMerge(repo, pull);
        if (mergeSha === null) {
          errors.push({ message: 'mergePullRequest: merge conflict' });
          return { value: null, typeName: 'MergePullRequestPayload' };
        }
        pull.merged = true;
        pull.mergedAt = FIXED_ISO;
        pull.mergeCommitSha = mergeSha;
        pull.state = 'closed';
        pull.closedAt = FIXED_ISO;
        pull.updatedAt = FIXED_ISO;
        pull.baseSha = mergeSha;
        return { value: { __typename: 'MergePullRequestPayload', pullRequest: pullView(repo, pull) }, typeName: 'MergePullRequestPayload' };
      }
      case 'addComment': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        if (parsed === null || parsed.kind !== 'Issue') {
          errors.push({ message: 'addComment: invalid subjectId' });
          return { value: null, typeName: 'AddCommentPayload' };
        }
        const repo = findRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
        const issue = repo?.issues.get(Number(parsed.parts[2]));
        if (repo === undefined || issue === undefined) {
          errors.push({ message: 'addComment: issue not found' });
          return { value: null, typeName: 'AddCommentPayload' };
        }
        const id = repo.nextCommentId++;
        const comment: Comment = {
          id,
          nodeId: globalId('IssueComment', `${repo.owner}/${repo.name}/${issue.number}/${id}`),
          body: String(input.body ?? ''),
          userLogin: VIEWER.login,
          createdAt: FIXED_ISO,
          updatedAt: FIXED_ISO,
        };
        issue.comments.push(comment);
        issue.jsonCache = null;
        return {
          value: { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node: commentView(repo, issue, comment) } },
          typeName: 'AddCommentPayload',
        };
      }
      default:
        errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
        return { value: null, typeName: 'String' };
    }
  }

  if (object === null) return { value: null, typeName: 'String' };

  if (typeName === 'Repository') {
    const repo = viewRepos.get(object);
    if (repo === undefined) return { value: null, typeName: 'String' };
    switch (field.name) {
      case 'issue': {
        const issue = repo.issues.get(Number(args.number ?? 0));
        return { value: issue === undefined ? null : issueView(repo, issue), typeName: 'Issue' };
      }
      case 'issues':
        return { value: issueConnection(repo, args), typeName: 'IssueConnection' };
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number ?? 0));
        return { value: pull === undefined ? null : pullView(repo, pull), typeName: 'PullRequest' };
      }
      case 'pullRequests':
        return { value: pullConnection(repo, args), typeName: 'PullRequestConnection' };
      default:
        break;
    }
  }

  if (typeName === 'Issue') {
    const entry = viewIssues.get(object);
    if (entry !== undefined) {
      switch (field.name) {
        case 'labels':
          return {
            value: {
              __typename: 'LabelConnection',
              nodes: entry.issue.labels.map(labelView),
              totalCount: entry.issue.labels.length,
            },
            typeName: 'LabelConnection',
          };
        case 'comments':
          return {
            value: {
              __typename: 'IssueCommentConnection',
              nodes: entry.issue.comments.map((comment) => commentView(entry.repo, entry.issue, comment)),
              totalCount: entry.issue.comments.length,
            },
            typeName: 'IssueCommentConnection',
          };
        default:
          break;
      }
    }
  }

  if (typeName === 'PullRequest') {
    const entry = viewPulls.get(object);
    if (entry !== undefined && field.name === 'files') {
      return { value: fileConnection(entry.repo, entry.pull, args), typeName: 'PullRequestFileConnection' };
    }
  }

  // Generic record lookup.
  if (field.name in object) {
    const value = object[field.name];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { value, typeName: String((value as Record<string, unknown>).__typename ?? 'Object') };
    }
    return { value, typeName: Array.isArray(value) ? 'List' : 'String' };
  }
  errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return { value: null, typeName: 'String' };
}

/** Execute a selection set against a view object. */
function executeGqlSelections(
  typeName: string,
  object: Record<string, unknown> | null,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
  varDefs: GqlVarDef[],
  errors: GqlError[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, executeGqlSelections(typeName, object, selection.selections, variables, varDefs, errors));
      }
      continue;
    }
    const args = resolveGqlArgs(selection, variables, varDefs);
    const { value, typeName: valueType } = resolveGqlField(typeName, object, selection, args, errors);
    const key = selection.alias ?? selection.name;
    if (value === null || value === undefined) {
      out[key] = null;
    } else if (selection.selections.length === 0) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.map((element) =>
        element !== null && typeof element === 'object'
          ? executeGqlSelections(String((element as Record<string, unknown>).__typename ?? valueType), element as Record<string, unknown>, selection.selections, variables, varDefs, errors)
          : element,
      );
    } else if (typeof value === 'object') {
      out[key] = executeGqlSelections(String((value as Record<string, unknown>).__typename ?? valueType), value as Record<string, unknown>, selection.selections, variables, varDefs, errors);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function executeGqlOperation(operation: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const errors: GqlError[] = [];
  const data = executeGqlSelections('Query', null, operation.selections, variables, operation.varDefs, errors);
  const response: Record<string, unknown> = { data };
  if (errors.length > 0) response.errors = errors;
  return response;
}

function handleGraphql(ctx: HttpContext): void {
  if (!requireAuth(ctx)) return;
  const body = parseJsonBody(ctx);
  if (body === false) {
    sendJson(ctx, 400, { errors: [{ message: 'Parse error: invalid JSON' }] });
    return;
  }
  const documents = Array.isArray(body) ? body : [body];
  const responses: Record<string, unknown>[] = [];
  for (const document of documents) {
    const input = (document ?? {}) as Record<string, unknown>;
    const query = typeof input.query === 'string' ? input.query : '';
    const variables = (input.variables ?? {}) as Record<string, unknown>;
    try {
      const parser = new GqlParser(gqlTokenize(query));
      const operations = parser.parseDocument();
      const operationName = typeof input.operationName === 'string' ? input.operationName : null;
      const operation = operationName === null ? operations[0]! : operations.find((candidate) => candidate.name === operationName) ?? operations[0]!;
      if (operation === undefined) throw new Error('GraphQL: no operation');
      responses.push(executeGqlOperation(operation, variables));
    } catch (err) {
      responses.push({ data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    }
  }
  sendJson(ctx, 200, Array.isArray(body) ? responses : responses[0]!);
}

// ---------------------------------------------------------------------------
// MCP (/mcp) — JSON-RPC 2.0 Streamable HTTP
// ---------------------------------------------------------------------------

const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const MCP_SESSION_ID = 'forge-session-1';

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, string>>;
    required: string[];
  };
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** A JSON-RPC error result. */
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function mcpResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** The tool-call result envelope: text plus structured content. */
function mcpToolResult(obj: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
  };
}

/** Look up the repository a tool call names, or null. */
function mcpRepo(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  return findRepo(owner, name) ?? null;
}

/** Run one MCP tool; throws {code, message} on a tool-level failure. */
function runMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const fail = (message: string): never => {
    throw { code: -32602, message };
  };
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') fail('create_repo: "name" is required');
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
      if (owner !== VIEWER.login) fail('create_repo: cannot create a repository for another owner');
      if (findRepo(owner, repoName) !== undefined) fail(`create_repo: repository "${repoName}" already exists`);
      const repo = createRepo(owner, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = mcpRepo(args);
      if (repo === null) fail('get_repo: repository not found');
      return mcpToolResult(repoJson(repo!));
    }
    case 'create_issue': {
      const repo = mcpRepo(args);
      if (repo === null) fail('create_issue: repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') fail('create_issue: "title" is required');
      const issue = createIssue(repo!, title, typeof args.body === 'string' ? args.body : '', []);
      return mcpToolResult(issueJson(repo!, issue));
    }
    case 'list_issues': {
      const repo = mcpRepo(args);
      if (repo === null) fail('list_issues: repository not found');
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...repo!.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      return mcpToolResult({ issues: issues.map((issue) => issueJson(repo!, issue)) });
    }
    case 'create_pull_request': {
      const repo = mcpRepo(args);
      if (repo === null) fail('create_pull_request: repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || head === '' || base === '') fail('create_pull_request: "title", "head" and "base" are required');
      const pull = createPull(repo!, title, typeof args.body === 'string' ? args.body : '', head, base);
      if (pull === null) fail('create_pull_request: head or base branch does not exist');
      return mcpToolResult(pullJson(repo!, pull));
    }
    case 'merge_pull_request': {
      const repo = mcpRepo(args);
      if (repo === null) fail('merge_pull_request: repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo!.pulls.get(number);
      if (pull === undefined) fail('merge_pull_request: pull request not found');
      if (pull!.state !== 'open') fail('merge_pull_request: pull request is not open');
      const mergeSha = squashMerge(repo!, pull!);
      if (mergeSha === null) fail('merge_pull_request: merge conflict');
      pull!.merged = true;
      pull!.mergedAt = FIXED_ISO;
      pull!.mergeCommitSha = mergeSha;
      pull!.state = 'closed';
      pull!.closedAt = FIXED_ISO;
      pull!.updatedAt = FIXED_ISO;
      pull!.baseSha = mergeSha;
      return mcpToolResult({ merged: true, sha: mergeSha, number: pull!.number, message: 'Pull Request successfully merged' });
    }
    default:
      fail(`Unknown tool: ${name}`);
  }
}

function handleMcp(ctx: HttpContext): void {
  if (ctx.method === 'DELETE') {
    // Legacy-era session teardown.
    sendNoContent(ctx, 204);
    return;
  }
  if (ctx.method !== 'POST') {
    sendError(ctx, 405, 'Method Not Allowed');
    return;
  }
  if (!isAuthenticated(ctx)) {
    sendError(ctx, 401, 'Requires authentication');
    return;
  }
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(ctx.body.toString('utf8')) as Record<string, unknown>;
  } catch {
    sendJson(ctx, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const sessionHeader = typeof ctx.req.headers['mcp-session-id'] === 'string' ? ctx.req.headers['mcp-session-id'] : MCP_SESSION_ID;
  const headers: Record<string, string> = { 'mcp-session-id': sessionHeader };

  // A notification (no id) is answered 202 with an empty body.
  if (id === null && method !== '') {
    sendNoContent(ctx, 202);
    return;
  }

  let response: Record<string, unknown>;
  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: VERSION };
      response = mcpResult(id, {
        supportedVersions: [...MCP_VERSIONS],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
      response._meta = { 'io.modelcontextprotocol/serverInfo': serverInfo };
      break;
    }
    case 'initialize':
      response = mcpResult(id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: VERSION },
      });
      break;
    case 'ping':
      response = mcpResult(id, {});
      break;
    case 'tools/list':
      // The same constant array, serialized in the same order every time.
      response = mcpResult(id, { tools: MCP_TOOLS });
      break;
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) {
        response = mcpError(id, -32602, `Unknown tool: ${toolName}`);
        break;
      }
      const missing = tool.inputSchema.required.filter((key) => toolArgs[key] === undefined || toolArgs[key] === null || toolArgs[key] === '');
      if (missing.length > 0) {
        response = mcpError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
        break;
      }
      try {
        response = mcpResult(id, runMcpTool(toolName, toolArgs));
      } catch (err) {
        const failure = err as { code?: number; message?: string };
        response = mcpError(id, failure.code ?? -32602, failure.message ?? 'Tool failed');
      }
      break;
    }
    default:
      response = mcpError(id, -32601, `Method not found: ${method}`);
      break;
  }
  sendJson(ctx, 200, response, headers);
}

// ---------------------------------------------------------------------------
// Router and lifecycle
// ---------------------------------------------------------------------------

/** The users the forge knows by login (the viewer is the only author). */
const USERS_BY_LOGIN: ReadonlyMap<string, { id: number; login: string; name: string; email: string }> = new Map([[VIEWER.login, VIEWER]]);

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    res.writeHead(400, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ message: 'Bad Request' }));
    return;
  }
  const pathname = url.pathname;
  const segments = pathSegments(pathname);
  const query = queryParams(url.search.startsWith('?') ? url.search.slice(1) : url.search);
  let body = Buffer.alloc(0);
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ message: 'Bad Request' }));
    return;
  }
  const ctx: HttpContext = { req, res, method, pathname, search: url.search, query, segments, body };
  try {
    if (method === 'GET' && pathname === '/healthz') {
      sendJson(ctx, 200, { ok: true });
      return;
    }
    // git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
      if (method === 'GET' && segments[2] === 'info' && segments[3] === 'refs') {
        const service = query.get('service') ?? '';
        if (service === 'git-upload-pack' || service === 'git-receive-pack') {
          handleInfoRefs(ctx, service);
          return;
        }
        sendError(ctx, 400, 'Invalid service');
        return;
      }
      if (method === 'POST' && segments[2] === 'git-upload-pack') {
        handleUploadPackPost(ctx);
        return;
      }
      if (method === 'POST' && segments[2] === 'git-receive-pack') {
        handleReceivePack(ctx);
        return;
      }
    }
    if (pathname === '/api/graphql' && method === 'POST') {
      handleGraphql(ctx);
      return;
    }
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      handleRest(ctx);
      return;
    }
    if (pathname === '/mcp') {
      handleMcp(ctx);
      return;
    }
    sendError(ctx, 404, 'Not Found');
  } catch (err) {
    // One bad request must never take the server down.
    try {
      sendError(ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
    } catch {
      // The peer went away.
    }
  }
}

async function main(): Promise<void> {
  const server: Server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  if (ENV_URL === '') {
    // No environment to register with: serve until killed (local development).
    await new Promise(() => {});
    return;
  }

  // Register our port, retrying with exponential backoff until accepted.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) break;
    } catch {
      // Retry below.
    }
    await sleep(Math.min(1000 * 2 ** attempt, 10000));
  }

  // Poll /done until the suite finishes the trial, then exit cleanly.
  for (;;) {
    await sleep(500);
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const data = (await response.json()) as Record<string, unknown>;
        if (data.done === true) break;
      }
    } catch {
      // Keep polling.
    }
  }
  server.close();
}

await main();
process.exit(0);
