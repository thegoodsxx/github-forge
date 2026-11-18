// Git Smart HTTP protocol handler (v2 and v0)
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
  type Repository,
  type TreeEntry,
  ZERO_OID,
  asBuffer,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
} from './store.ts';

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const chunks: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') chunks.push(pktLineFlush());
    else if (item === 'delim') chunks.push(pktLineDelim());
    else if (item === 'response-end') chunks.push(pktLineResponseEnd());
    else chunks.push(encodePktLine(item));
  }
  return Buffer.concat(chunks);
}

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

export class PktLineDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(initial?: Uint8Array) {
    if (initial && initial.length) this.push(initial);
  }

  push(chunk: Uint8Array): void {
    if (this.ended) throw new Error('decoder already finished');
    const buf = asBuffer(chunk);
    if (!buf.length) return;
    this.chunks.push(buf);
    this.buffered += buf.length;
  }

  finish(): void {
    this.ended = true;
  }

  private peek(n: number): Buffer | null {
    if (this.buffered < n) return null;
    if (this.chunks[0] && this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      const take = Math.min(chunk.length, n - filled);
      chunk.copy(out, filled, 0, take);
      filled += take;
      if (filled === n) break;
    }
    return out;
  }

  private take(n: number): Buffer {
    if (this.buffered < n) throw new Error('not enough buffered bytes');
    if (this.chunks[0] && this.chunks[0].length === n) {
      this.buffered -= n;
      return this.chunks.shift()!;
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0]!;
      const need = n - filled;
      if (chunk.length <= need) {
        chunk.copy(out, filled);
        filled += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[0] = chunk.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }

  next(): GitPacket | null {
    if (this.buffered < 4) return null;
    const header = this.peek(4)!.toString('ascii');
    const length = Number.parseInt(header, 16);
    if (Number.isNaN(length)) throw new Error(`invalid pkt-line length ${header}`);
    if (length === 0) {
      this.take(4);
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.take(4);
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.take(4);
      return { kind: 'response-end' };
    }
    if (this.buffered < length) return null;
    const raw = this.take(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }

  takeRemaining(): Buffer {
    if (!this.buffered) return Buffer.alloc(0);
    const out = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    return out;
  }
}

export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const decoder = new PktLineDecoder(bytes);
  decoder.finish();
  const packets: GitPacket[] = [];
  for (let p = decoder.next(); p !== null; p = decoder.next()) {
    packets.push(p);
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// Packfile Parsing and Creation
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
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

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
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
    }
  }
  return out;
}

export function readPack(pack: Uint8Array, resolveBase?: ObjectLookup): Map<string, GitObject> {
  const buffer = asBuffer(pack);
  if (buffer.length < 32 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('invalid pack header');
  }
  const declaredCount = buffer.readUInt32BE(8);
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let i = 0; i < declaredCount; i++) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, GitObject>();

  function resolveEntry(entry: RawEntry): GitObject {
    if (resolved.has(entry.offset)) return resolved.get(entry.offset)!;
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset!);
      if (!base) throw new Error('missing ofs base');
      const baseObj = resolveEntry(base);
      type = baseObj.type;
      data = applyDelta(baseObj.data, entry.data);
    } else if (entry.typeCode === 7) {
      let baseObj = [...objects.values()].find((o) => hashObject(o.type, o.data) === entry.baseOid);
      if (!baseObj && resolveBase) baseObj = resolveBase(entry.baseOid!);
      if (!baseObj) throw new Error(`missing ref delta base ${entry.baseOid}`);
      type = baseObj.type;
      data = applyDelta(baseObj.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const result: GitObject = { type, data };
    resolved.set(entry.offset, result);
    const oid = hashObject(type, data);
    objects.set(oid, result);
    return result;
  }

  for (const entry of raw) {
    resolveEntry(entry);
  }
  return objects;
}

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

const deflatedCache = new WeakMap<GitObject, Buffer>();

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    let deflated = deflatedCache.get(object);
    if (!deflated) {
      const data = asBuffer(object.data);
      deflated = Buffer.concat([
        writePackObjectHeader(object.type, data.length),
        deflateSync(data, { level: 1 }),
      ]);
      deflatedCache.set(object, deflated);
    }
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// Git Smart HTTP Request Handlers
// ---------------------------------------------------------------------------------------------

export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repository, service: string): void {
  const isV2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
  if (service === 'git-upload-pack') {
    res.setHeader('content-type', 'application/x-git-upload-pack-advertisement');
    res.setHeader('cache-control', 'no-cache');
    if (isV2) {
      // Protocol v2 capability advertisement
      const lines: string[] = [
        'version 2\n',
        'agent=makefun-git-forge/1.0\n',
        'ls-refs=peel symrefs unborn\n',
        'fetch=shallow filter\n',
        'server-option\n',
        'object-format=sha1\n',
      ];
      const body = encodePktLines([...lines, 'flush']);
      res.writeHead(200);
      res.end(body);
      return;
    }

    // Protocol v0 upload-pack advertisement
    const parts: Buffer[] = [
      encodePktLine('# service=git-upload-pack\n'),
      pktLineFlush(),
    ];
    const headTarget = repo.headSymref || `refs/heads/${repo.defaultBranch}`;
    const caps = `multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag symref=HEAD:${headTarget} agent=makefun-git-forge/1.0 object-format=sha1`;
    const sortedRefs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (sortedRefs.length === 0) {
      parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    } else {
      let isFirst = true;
      // Head ref if present
      const headOid = repo.refs.get(headTarget);
      if (headOid) {
        parts.push(encodePktLine(`${headOid} HEAD\u0000${caps}\n`));
        isFirst = false;
      }
      for (const [refName, oid] of sortedRefs) {
        if (isFirst) {
          parts.push(encodePktLine(`${oid} ${refName}\u0000${caps}\n`));
          isFirst = false;
        } else {
          parts.push(encodePktLine(`${oid} ${refName}\n`));
        }
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const tag = parseTag(obj.data);
          if (tag.object) parts.push(encodePktLine(`${tag.object} ${refName}^{}\n`));
        }
      }
    }
    parts.push(pktLineFlush());
    res.writeHead(200);
    res.end(Buffer.concat(parts));
    return;
  }

  if (service === 'git-receive-pack') {
    res.setHeader('content-type', 'application/x-git-receive-pack-advertisement');
    res.setHeader('cache-control', 'no-cache');
    const parts: Buffer[] = [
      encodePktLine('# service=git-receive-pack\n'),
      pktLineFlush(),
    ];
    const caps = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=makefun-git-forge/1.0 object-format=sha1';
    const sortedRefs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (sortedRefs.length === 0) {
      parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    } else {
      let isFirst = true;
      for (const [refName, oid] of sortedRefs) {
        if (isFirst) {
          parts.push(encodePktLine(`${oid} ${refName}\u0000${caps}\n`));
          isFirst = false;
        } else {
          parts.push(encodePktLine(`${oid} ${refName}\n`));
        }
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const tag = parseTag(obj.data);
          if (tag.object) parts.push(encodePktLine(`${tag.object} ${refName}^{}\n`));
        }
      }
    }
    parts.push(pktLineFlush());
    res.writeHead(200);
    res.end(Buffer.concat(parts));
    return;
  }

  res.writeHead(400);
  res.end('invalid service');
}

export function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repository,
  bodyBuffer: Buffer,
): void {
  let packets: GitPacket[];
  try {
    packets = decodePktLines(bodyBuffer);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Malformed pkt-line request\n');
    return;
  }

  res.setHeader('content-type', 'application/x-git-upload-pack-result');
  res.setHeader('cache-control', 'no-cache');
  const dataLines = packets
    .filter((p): p is { kind: 'data'; payload: Buffer; raw: Buffer } => p.kind === 'data')
    .map((p) => p.payload.toString('utf8'));

  const firstLine = dataLines[0]?.trim() ?? '';

  if (firstLine === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (let i = 1; i < dataLines.length; i++) {
      const line = dataLines[i]!.trim();
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).trim());
    }

    const headTarget = repo.headSymref || `refs/heads/${repo.defaultBranch}`;
    const headOid = repo.refs.get(headTarget);
    const sortedRefs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const outLines: string[] = [];

    // HEAD ref if matching prefix
    const headMatches = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
    if (headMatches) {
      if (!headOid && unborn) {
        outLines.push(`unborn HEAD symref-target:${headTarget}\n`);
      } else if (headOid) {
        let line = `${headOid} HEAD`;
        if (symrefs) line += ` symref-target:${headTarget}`;
        outLines.push(line + '\n');
      }
    }

    for (const [refName, oid] of sortedRefs) {
      if (prefixes.length > 0 && !prefixes.some((p) => refName.startsWith(p))) continue;
      let line = `${oid} ${refName}`;
      if (peel) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const tag = parseTag(obj.data);
          if (tag.object) line += ` peeled:${tag.object}`;
        }
      }
      outLines.push(line + '\n');
    }

    const reply = encodePktLines([...outLines, 'flush']);
    res.writeHead(200);
    res.end(reply);
    return;
  }

  // Fetch command (v2 or v0)
  const wants: string[] = [];
  const haves = new Set<string>();
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  let done = false;

  for (const line of dataLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('want ')) {
      const parts = trimmed.split(' ');
      const wantOid = parts[1];
      if (wantOid && isObjectId(wantOid)) wants.push(wantOid);
    } else if (trimmed.startsWith('have ')) {
      const parts = trimmed.split(' ');
      const haveOid = parts[1];
      if (haveOid && isObjectId(haveOid)) haves.add(haveOid);
    } else if (trimmed.startsWith('shallow ')) {
      const parts = trimmed.split(' ');
      const shallowOid = parts[1];
      if (shallowOid && isObjectId(shallowOid)) clientShallow.add(shallowOid);
    } else if (trimmed.startsWith('deepen ')) {
      depth = Number.parseInt(trimmed.slice('deepen '.length).trim(), 10);
    } else if (trimmed === 'done') {
      done = true;
    }
  }

  // Check if wants are already in haves
  const alreadySatisfied = wants.length > 0 && wants.every((w) => haves.has(w));

  // Determine objects and shallow info
  const shallowSet = new Set<string>();
  const unshallowSet = new Set<string>();
  const objectsToSend: GitObject[] = [];

  if (depth !== null && depth > 0) {
    // Traverse commit graph from wants down to depth
    interface WalkNode {
      oid: string;
      d: number;
    }
    const queue: WalkNode[] = wants.map((w) => ({ oid: w, d: 1 }));
    const visitedCommits = new Set<string>();
    const treeOids = new Set<string>();

    while (queue.length > 0) {
      const { oid, d } = queue.shift()!;
      if (visitedCommits.has(oid)) continue;
      visitedCommits.add(oid);
      const commitObj = repo.objects.get(oid);
      if (!commitObj || commitObj.type !== 'commit') continue;
      const parsed = parseCommit(commitObj.data);
      if (parsed.tree) treeOids.add(parsed.tree);

      if (d < depth) {
        for (const parent of parsed.parents) {
          queue.push({ oid: parent, d: d + 1 });
        }
      } else {
        // At max depth: if it has parents, it's a shallow boundary
        if (parsed.parents.length > 0) {
          shallowSet.add(oid);
        }
      }
    }

    // Unshallow any commit that was in clientShallow but now has parents explored
    for (const sh of clientShallow) {
      if (visitedCommits.has(sh) && !shallowSet.has(sh)) {
        unshallowSet.add(sh);
      }
    }

    // Collect all trees and blobs
    const allReachable = collectReachable(treeOids, (id) => repo.objects.get(id));
    for (const commitOid of visitedCommits) {
      const obj = repo.objects.get(commitOid);
      if (obj) objectsToSend.push(obj);
    }
    for (const objOid of allReachable) {
      const obj = repo.objects.get(objOid);
      if (obj) objectsToSend.push(obj);
    }
  } else if (!alreadySatisfied) {
    // Normal fetch: all reachable from wants minus haves
    const haveReachable = collectReachable(haves, (id) => repo.objects.get(id), { allowMissing: true });
    const wantReachable = collectReachable(wants, (id) => repo.objects.get(id));
    for (const oid of wantReachable) {
      if (!haveReachable.has(oid)) {
        const obj = repo.objects.get(oid);
        if (obj) objectsToSend.push(obj);
      }
    }
  }

  const packBuffer = writePack(objectsToSend);

  // Response framing (protocol v2 format with sections)
  const responseChunks: Buffer[] = [];

  // Acknowledgment section
  responseChunks.push(encodePktLine('acknowledgments\n'));
  if (haves.size > 0) {
    for (const h of haves) {
      if (repo.objects.has(h)) responseChunks.push(encodePktLine(`ACK ${h}\n`));
    }
    responseChunks.push(encodePktLine('ready\n'));
  } else {
    responseChunks.push(encodePktLine('NAK\n'));
  }
  responseChunks.push(pktLineDelim());

  // Shallow-info section if shallow was used
  if (shallowSet.size > 0 || unshallowSet.size > 0) {
    responseChunks.push(encodePktLine('shallow-info\n'));
    for (const sh of shallowSet) {
      responseChunks.push(encodePktLine(`shallow ${sh}\n`));
    }
    for (const unsh of unshallowSet) {
      responseChunks.push(encodePktLine(`unshallow ${unsh}\n`));
    }
    responseChunks.push(pktLineDelim());
  }

  // Packfile section
  responseChunks.push(encodePktLine('packfile\n'));
  const CHUNK_SIZE = 65515;
  for (let offset = 0; offset < packBuffer.length; offset += CHUNK_SIZE) {
    const slice = packBuffer.subarray(offset, offset + CHUNK_SIZE);
    const framed = Buffer.allocUnsafe(slice.length + 1);
    framed[0] = 1; // Band 1
    slice.copy(framed, 1);
    responseChunks.push(encodePktLine(framed));
  }
  responseChunks.push(pktLineFlush());

  res.writeHead(200);
  res.end(Buffer.concat(responseChunks));
}

export function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repository,
  bodyBuffer: Buffer,
): void {
  const decoder = new PktLineDecoder(bodyBuffer);
  const commandLines: string[] = [];
  let sideband = false;

  try {
    for (let packet = decoder.next(); packet !== null; packet = decoder.next()) {
      if (packet.kind === 'flush') break;
      if (packet.kind === 'data') {
        commandLines.push(packet.payload.toString('utf8'));
      }
    }
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Malformed pkt-line request\n');
    return;
  }

  res.setHeader('content-type', 'application/x-git-receive-pack-result');
  res.setHeader('cache-control', 'no-cache');

  const remainingPack = decoder.takeRemaining();
  if (remainingPack.length > 0) {
    try {
      const parsedObjects = readPack(remainingPack, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of parsedObjects) {
        repo.objects.set(oid, obj);
      }
    } catch {
      // Pack unpack error
    }
  }

  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];

  for (let i = 0; i < commandLines.length; i++) {
    let line = commandLines[i]!.replace(/\n$/, '');
    if (i === 0) {
      const nulIdx = line.indexOf('\u0000');
      if (nulIdx >= 0) {
        const caps = line.slice(nulIdx + 1);
        if (caps.includes('side-band-64k')) sideband = true;
        line = line.slice(0, nulIdx);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }

  const reportLines: string[] = ['unpack ok\n'];

  for (const cmd of commands) {
    if (cmd.newOid === ZERO_OID) {
      // Delete ref
      repo.refs.delete(cmd.ref);
      reportLines.push(`ok ${cmd.ref}\n`);
    } else if (cmd.oldOid === ZERO_OID) {
      // Create ref
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    } else {
      // Update ref - verify fast-forward
      const isFf = isAncestor(cmd.oldOid, cmd.newOid, (oid) => repo.objects.get(oid));
      if (isFf) {
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
      } else {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      }
    }
  }

  // Format response
  const reportPktLines = encodePktLines([...reportLines, 'flush']);
  let responseData: Buffer;
  if (sideband) {
    // Demux into band 1
    const band1Header = Buffer.from([1]);
    responseData = Buffer.concat([
      encodePktLine(Buffer.concat([band1Header, reportPktLines])),
      pktLineFlush(),
    ]);
  } else {
    responseData = reportPktLines;
  }

  res.writeHead(200);
  res.end(responseData);
}
