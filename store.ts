// In-memory data store and Git object engine for github-core-clone-01 forge
// Provides full support for loose Git objects, commit graph reachability,
// recursive tree parsing and mutations, and forge domain models.
import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export const ZERO_OID = '0'.repeat(40);
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

export function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

const HEX40 = /^[0-9a-f]{40}$/i;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) break;
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      continue;
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree) queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.object) queue.push(tag.object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

export function isAncestor(ancestorOid: string, descendantOid: string, lookup: ObjectLookup): boolean {
  if (ancestorOid === descendantOid) return true;
  if (!isObjectId(ancestorOid) || !isObjectId(descendantOid)) return false;
  if (ancestorOid === ZERO_OID) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendantOid];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestorOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj && obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      for (const parent of parsed.parents) {
        if (!seen.has(parent)) queue.push(parent);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Forge Store Model
// ---------------------------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  user: { login: string; id: number };
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: { login: string; id: number };
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  createdAt: string;
  updatedAt: string;
  user: { login: string; id: number };
}

export interface Repository {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  headSymref: string;
  issues: Map<number, Issue>;
  nextIssueNumber: number;
  labels: Map<string, Label>;
  pulls: Map<number, PullRequest>;
  nextPullNumber: number;
  nextCommentId: number;
}

export class ForgeStore {
  readonly repos = new Map<string, Repository>();
  private nextRepoId = 1000;
  private nextGlobalId = 5000;
  public viewerLogin = 'adaiversen';

  private nowIso(): string {
    return '2026-11-14T00:00:00Z';
  }

  getRepo(owner: string, name: string): Repository | undefined {
    return this.repos.get(`${owner.toLowerCase()}/${name.toLowerCase()}`);
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repository {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const now = this.nowIso();
    const repo: Repository = {
      id: this.nextRepoId++,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      headSymref: `refs/heads/${options.defaultBranch ?? 'main'}`,
      issues: new Map(),
      nextIssueNumber: 1,
      labels: new Map(),
      pulls: new Map(),
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    return this.repos.delete(key);
  }

  listReposForUser(owner: string): Repository[] {
    const list: Repository[] = [];
    const lowerOwner = owner.toLowerCase();
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === lowerOwner) {
        list.push(repo);
      }
    }
    return list;
  }

  // File tree operations
  getFileAtCommit(repo: Repository, commitSha: string, filePath: string): { blob: GitObject; sha: string } | null {
    const commitObj = repo.objects.get(commitSha);
    if (!commitObj || commitObj.type !== 'commit') return null;
    const commit = parseCommit(commitObj.data);
    return this.getFileAtTree(repo, commit.tree, filePath);
  }

  getFileAtTree(repo: Repository, treeOid: string, filePath: string): { blob: GitObject; sha: string } | null {
    const parts = filePath.split('/').filter(Boolean);
    let curTreeOid = treeOid;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const treeObj = repo.objects.get(curTreeOid);
      if (!treeObj || treeObj.type !== 'tree') return null;
      const entries = parseTree(treeObj.data);
      const isLeaf = i === parts.length - 1;
      const entry = entries.find((e) => e.name === part);
      if (!entry) return null;
      if (isLeaf) {
        if (entry.mode === '40000') return null; // Expected file, found dir
        const blobObj = repo.objects.get(entry.oid);
        if (!blobObj) return null;
        return { blob: blobObj, sha: entry.oid };
      } else {
        if (entry.mode !== '40000') return null; // Expected dir, found file
        curTreeOid = entry.oid;
      }
    }
    return null;
  }

  getDirectoryEntriesAtTree(repo: Repository, treeOid: string, dirPath: string): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> | null {
    const parts = dirPath.split('/').filter(Boolean);
    let curTreeOid = treeOid;
    for (const part of parts) {
      const treeObj = repo.objects.get(curTreeOid);
      if (!treeObj || treeObj.type !== 'tree') return null;
      const entries = parseTree(treeObj.data);
      const entry = entries.find((e) => e.name === part && e.mode === '40000');
      if (!entry) return null;
      curTreeOid = entry.oid;
    }
    const targetObj = repo.objects.get(curTreeOid);
    if (!targetObj || targetObj.type !== 'tree') return null;
    const entries = parseTree(targetObj.data);
    const prefix = parts.length > 0 ? parts.join('/') + '/' : '';
    return entries.map((entry) => {
      const isDir = entry.mode === '40000';
      const size = isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
      return {
        name: entry.name,
        path: `${prefix}${entry.name}`,
        sha: entry.oid,
        type: isDir ? ('dir' as const) : ('file' as const),
        size,
      };
    });
  }

  private updateTreeRecursive(
    repo: Repository,
    treeOid: string | null,
    parts: string[],
    blobOid: string | null,
  ): string {
    const [head, ...tail] = parts;
    const entries: TreeEntry[] = treeOid ? parseTree(repo.objects.get(treeOid)!.data) : [];
    const index = entries.findIndex((e) => e.name === head);

    if (tail.length === 0) {
      // Leaf
      if (blobOid === null) {
        // Delete
        if (index >= 0) entries.splice(index, 1);
      } else {
        // Add or update file
        const newEntry: TreeEntry = { mode: '100644', name: head, oid: blobOid };
        if (index >= 0) entries[index] = newEntry;
        else entries.push(newEntry);
      }
    } else {
      // Subdirectory
      const existingSubTreeOid = index >= 0 && entries[index].mode === '40000' ? entries[index].oid : null;
      const newSubTreeOid = this.updateTreeRecursive(repo, existingSubTreeOid, tail, blobOid);
      const newEntry: TreeEntry = { mode: '40000', name: head, oid: newSubTreeOid };
      if (index >= 0) entries[index] = newEntry;
      else entries.push(newEntry);
    }

    const treeData = buildTree(entries);
    const newTreeOid = hashObject('tree', treeData);
    repo.objects.set(newTreeOid, { type: 'tree', data: treeData });
    return newTreeOid;
  }

  putFile(
    repo: Repository,
    branchName: string,
    filePath: string,
    content: Buffer,
    message: string,
    authorName = CONFORMANCE_IDENTITY,
  ): { contentSha: string; commitSha: string } {
    const blobOid = hashObject('blob', content);
    repo.objects.set(blobOid, { type: 'blob', data: content });

    const refKey = `refs/heads/${branchName}`;
    const parentCommitSha = repo.refs.get(refKey);
    let rootTreeOid: string | null = null;
    if (parentCommitSha) {
      const parentObj = repo.objects.get(parentCommitSha);
      if (parentObj && parentObj.type === 'commit') {
        rootTreeOid = parseCommit(parentObj.data).tree;
      }
    }

    const parts = filePath.split('/').filter(Boolean);
    const newRootTreeOid = this.updateTreeRecursive(repo, rootTreeOid, parts, blobOid);

    const commitData = buildCommit({
      tree: newRootTreeOid,
      parents: parentCommitSha ? [parentCommitSha] : [],
      message,
      author: authorName,
      committer: authorName,
    });
    const commitSha = hashObject('commit', commitData);
    repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(refKey, commitSha);
    if (!repo.headSymref) repo.headSymref = refKey;

    return { contentSha: blobOid, commitSha };
  }

  deleteFile(
    repo: Repository,
    branchName: string,
    filePath: string,
    message: string,
    expectedSha?: string,
  ): { commitSha: string } | null {
    const refKey = `refs/heads/${branchName}`;
    const parentCommitSha = repo.refs.get(refKey);
    if (!parentCommitSha) return null;

    const parentObj = repo.objects.get(parentCommitSha);
    if (!parentObj || parentObj.type !== 'commit') return null;
    const rootTreeOid = parseCommit(parentObj.data).tree;

    if (expectedSha) {
      const existing = this.getFileAtTree(repo, rootTreeOid, filePath);
      if (!existing || existing.sha.toLowerCase() !== expectedSha.toLowerCase()) {
        return null;
      }
    }

    const parts = filePath.split('/').filter(Boolean);
    const newRootTreeOid = this.updateTreeRecursive(repo, rootTreeOid, parts, null);

    const commitData = buildCommit({
      tree: newRootTreeOid,
      parents: [parentCommitSha],
      message,
    });
    const commitSha = hashObject('commit', commitData);
    repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(refKey, commitSha);

    return { commitSha };
  }
}

export const globalStore = new ForgeStore();
