// Model Context Protocol (Streamable HTTP transport) handler
// Compliant with 2026-07-28 server/discover and legacy initialize/tools protocols.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  type Issue,
  type PullRequest,
  type Repository,
  buildCommit,
  globalStore,
  hashObject,
  parseCommit,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
  });
  res.end(text);
}

function checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  return auth.startsWith('Bearer ') && auth.slice(7).trim().length > 0;
}

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository' },
        repo: { type: 'string', description: 'The repository name' },
        full_name: { type: 'string', description: 'The full repository name (owner/repo)' },
      },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner' },
        repo: { type: 'string', description: 'The repository name' },
        full_name: { type: 'string', description: 'The full repository name (owner/repo)' },
        title: { type: 'string', description: 'The title of the issue' },
        body: { type: 'string', description: 'The body of the issue' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner' },
        repo: { type: 'string', description: 'The repository name' },
        full_name: { type: 'string', description: 'The full repository name (owner/repo)' },
        state: { type: 'string', description: 'Filter by state (open, closed, all)' },
      },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner' },
        repo: { type: 'string', description: 'The repository name' },
        full_name: { type: 'string', description: 'The full repository name (owner/repo)' },
        title: { type: 'string', description: 'The title of the pull request' },
        head: { type: 'string', description: 'The branch that contains the changes' },
        base: { type: 'string', description: 'The branch into which changes should be merged' },
      },
      required: ['title', 'head'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner' },
        repo: { type: 'string', description: 'The repository name' },
        full_name: { type: 'string', description: 'The full repository name (owner/repo)' },
        pull_number: { type: 'number', description: 'The pull request number' },
        number: { type: 'number', description: 'The pull request number' },
      },
    },
  },
];

function resolveOwnerRepo(args: Record<string, any>): { owner: string; repo: string } {
  let owner = String(args.owner ?? '');
  let repo = String(args.repo ?? '');
  if (args.full_name && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length >= 2) {
      if (!owner) owner = parts[0]!;
      if (!repo) repo = parts[1]!;
    }
  }
  if (!owner) owner = globalStore.viewerLogin;
  return { owner, repo };
}

function normalizeToolName(name: string): string {
  const lower = name.toLowerCase();
  const idx = lower.lastIndexOf('__');
  const base = idx >= 0 ? lower.slice(idx + 2) : lower;
  return base;
}

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');

  let rpc: any;
  try {
    rpc = JSON.parse(raw);
  } catch {
    // Malformed JSON answers HTTP 400 with -32700
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
      },
    });
    return;
  }

  const method = rpc.method;
  const id = rpc.id ?? null;
  const params = rpc.params ?? {};

  // server/discover (2026-07-28)
  if (method === 'server/discover') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: ['2026-07-28'],
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'github-forge',
          version: '1.0.0',
        },
      },
    });
    return;
  }

  // initialize (legacy handshake)
  if (method === 'initialize') {
    const requested = params.protocolVersion ?? '2024-11-05';
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'github-forge',
          version: '1.0.0',
        },
      },
    });
    return;
  }

  // notifications/initialized
  if (method === 'notifications/initialized') {
    res.writeHead(204);
    res.end();
    return;
  }

  // tools/list
  if (method === 'tools/list') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS,
      },
    });
    return;
  }

  // tools/call
  if (method === 'tools/call') {
    // Auth check required for tools/call
    if (!checkAuth(req)) {
      sendJson(res, 401, {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: 'Unauthorized',
        },
      });
      return;
    }

    const toolName = normalizeToolName(params.name ?? '');
    const args = params.arguments ?? {};

    if (toolName === 'create_repo') {
      const name = args.name ? String(args.name).trim() : '';
      if (!name) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'Missing required argument: name' }],
          },
        });
        return;
      }
      const repo = globalStore.createRepo(globalStore.viewerLogin, name, {
        description: args.description,
        private: args.private === true,
      });
      const data = {
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.private,
        description: repo.description,
      };
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          structuredContent: data,
        },
      });
      return;
    }

    if (toolName === 'get_repo') {
      const { owner, repo: rName } = resolveOwnerRepo(args);
      const repo = globalStore.getRepo(owner, rName);
      if (!repo) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'Repository not found' }],
          },
        });
        return;
      }
      const data = {
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.private,
        description: repo.description,
      };
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          structuredContent: data,
        },
      });
      return;
    }

    if (toolName === 'create_issue') {
      const { owner, repo: rName } = resolveOwnerRepo(args);
      const repo = globalStore.getRepo(owner, rName);
      const title = args.title ? String(args.title).trim() : '';
      if (!repo || !title) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'Invalid arguments or repository not found' }],
          },
        });
        return;
      }
      const num = repo.nextIssueNumber++;
      const issue: Issue = {
        id: repo.id * 1000 + num,
        number: num,
        title,
        body: args.body ? String(args.body) : '',
        state: 'open',
        labels: [],
        createdAt: '2026-11-14T00:00:00Z',
        updatedAt: '2026-11-14T00:00:00Z',
        closedAt: null,
        user: { login: globalStore.viewerLogin, id: 1000 },
        comments: [],
      };
      repo.issues.set(num, issue);
      const data = {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      };
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          structuredContent: data,
        },
      });
      return;
    }

    if (toolName === 'list_issues') {
      const { owner, repo: rName } = resolveOwnerRepo(args);
      const repo = globalStore.getRepo(owner, rName);
      if (!repo) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'Repository not found' }],
          },
        });
        return;
      }
      let issues = [...repo.issues.values()];
      if (args.state && args.state !== 'all') {
        issues = issues.filter((i) => i.state === args.state);
      }
      const data = issues.map((i) => ({
        id: i.id,
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
      }));
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          structuredContent: data,
        },
      });
      return;
    }

    if (toolName === 'create_pull_request') {
      const { owner, repo: rName } = resolveOwnerRepo(args);
      const repo = globalStore.getRepo(owner, rName);
      const title = args.title ? String(args.title).trim() : '';
      const head = args.head ? String(args.head).trim() : '';
      const base = args.base ? String(args.base).trim() : repo?.defaultBranch ?? 'main';
      if (!repo || !title || !head) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'Invalid arguments or repository not found' }],
          },
        });
        return;
      }
      const num = repo.nextPullNumber++;
      const headSha = repo.refs.get(`refs/heads/${head}`) ?? repo.refs.get(head) ?? ZERO_OID;
      const baseSha = repo.refs.get(`refs/heads/${base}`) ?? repo.refs.get(base) ?? ZERO_OID;
      const pull: PullRequest = {
        id: repo.id * 2000 + num,
        number: num,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        title,
        body: args.body ? String(args.body) : '',
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
        createdAt: '2026-11-14T00:00:00Z',
        updatedAt: '2026-11-14T00:00:00Z',
        user: { login: globalStore.viewerLogin, id: 1000 },
      };
      repo.pulls.set(num, pull);
      const data = {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        head: { ref: pull.head.ref, sha: pull.head.sha },
        base: { ref: pull.base.ref, sha: pull.base.sha },
      };
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          structuredContent: data,
        },
      });
      return;
    }

    if (toolName === 'merge_pull_request') {
      const { owner, repo: rName } = resolveOwnerRepo(args);
      const repo = globalStore.getRepo(owner, rName);
      const pullNum = Number(args.pull_number ?? args.number);
      const pull = repo?.pulls.get(pullNum);
      if (!repo || !pull) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'Pull request not found' }],
          },
        });
        return;
      }
      // Perform squash merge
      const headCommit = repo.objects.get(pull.head.sha);
      const headTree = headCommit ? parseCommit(headCommit.data).tree : '';
      const commitData = buildCommit({
        tree: headTree,
        parents: [pull.base.sha],
        message: `Merge pull request #${pull.number} from ${pull.head.ref}`,
      });
      const mergeSha = hashObject('commit', commitData);
      repo.objects.set(mergeSha, { type: 'commit', data: commitData });
      repo.refs.set(`refs/heads/${pull.base.ref}`, mergeSha);

      pull.merged = true;
      pull.mergedAt = '2026-11-14T00:00:00Z';
      pull.mergeCommitSha = mergeSha;
      pull.state = 'closed';

      const data = {
        merged: true,
        sha: mergeSha,
        message: 'Pull Request successfully merged',
      };
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          structuredContent: data,
        },
      });
      return;
    }

    // Unknown tool answers JSON-RPC error -32601
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Unknown tool: ${params.name}`,
      },
    });
    return;
  }

  // Unknown method
  sendJson(res, 200, {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  });
}
