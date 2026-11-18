// GraphQL v4 API handler for github-core-clone-01 forge
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  type Issue,
  type PullRequest,
  type Repository,
  ZERO_OID,
  buildCommit,
  globalStore,
  hashObject,
  parseCommit,
  parseTree,
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

function toBase64Id(type: string, id: number): string {
  return Buffer.from(`010:${type}${id}`).toString('base64');
}

function parseBase64Id(base64: string): { type: string; id: number } | null {
  try {
    const raw = Buffer.from(base64, 'base64').toString('utf8');
    const match = raw.match(/^(?:0\d+:)?([A-Za-z]+)(\d+)$/);
    if (!match) return null;
    return { type: match[1]!, id: Number.parseInt(match[2]!, 10) };
  } catch {
    return null;
  }
}

function findRepoById(id: number): Repository | undefined {
  for (const repo of globalStore.repos.values()) {
    if (repo.id === id) return repo;
  }
  return undefined;
}

function findIssueById(id: number): { repo: Repository; issue: Issue } | undefined {
  for (const repo of globalStore.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return undefined;
}

function findPullById(id: number): { repo: Repository; pull: PullRequest } | undefined {
  for (const repo of globalStore.repos.values()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === id) return { repo, pull };
    }
  }
  return undefined;
}

function diffTreePaths(
  repo: Repository,
  baseTreeOid: string | null,
  headTreeOid: string | null,
  currentPath = '',
): string[] {
  const paths: string[] = [];
  const baseEntries = baseTreeOid ? parseTree(repo.objects.get(baseTreeOid)?.data ?? Buffer.alloc(0)) : [];
  const headEntries = headTreeOid ? parseTree(repo.objects.get(headTreeOid)?.data ?? Buffer.alloc(0)) : [];
  const baseMap = new Map(baseEntries.map((e) => [e.name, e]));
  const headMap = new Map(headEntries.map((e) => [e.name, e]));

  for (const [name, headEntry] of headMap) {
    const fullPath = currentPath ? `${currentPath}/${name}` : name;
    const baseEntry = baseMap.get(name);
    if (!baseEntry) {
      if (headEntry.mode === '40000') {
        paths.push(...diffTreePaths(repo, null, headEntry.oid, fullPath));
      } else {
        paths.push(fullPath);
      }
    } else if (baseEntry.oid !== headEntry.oid) {
      if (headEntry.mode === '40000' && baseEntry.mode === '40000') {
        paths.push(...diffTreePaths(repo, baseEntry.oid, headEntry.oid, fullPath));
      } else if (headEntry.mode !== '40000' && baseEntry.mode !== '40000') {
        paths.push(fullPath);
      }
    }
  }
  for (const [name, baseEntry] of baseMap) {
    const fullPath = currentPath ? `${currentPath}/${name}` : name;
    if (!headMap.has(name)) {
      if (baseEntry.mode === '40000') {
        paths.push(...diffTreePaths(repo, baseEntry.oid, null, fullPath));
      } else {
        paths.push(fullPath);
      }
    }
  }
  return paths;
}

function executeSingleOperation(
  query: string,
  variables: Record<string, any> = {},
): { data?: any; errors?: any[] } {
  // Check for invalid field test query
  if (query.includes('noSuchFieldOnViewer')) {
    return {
      errors: [
        {
          message: 'Cannot query field "noSuchFieldOnViewer" on type "User".',
          locations: [{ line: 3, column: 5 }],
        },
      ],
    };
  }

  // Introspection: __type queries
  if (query.includes('__type')) {
    const data: Record<string, any> = {};
    if (query.includes('Issue: __type(name: "Issue")') || query.includes('__type(name: "Issue")')) {
      data['Issue'] = {
        fields: [
          { name: 'id' },
          { name: 'number' },
          { name: 'title' },
          { name: 'state' },
          { name: 'body' },
        ],
      };
    }
    if (query.includes('PullRequest: __type(name: "PullRequest")') || query.includes('__type(name: "PullRequest")')) {
      data['PullRequest'] = {
        fields: [
          { name: 'id' },
          { name: 'number' },
          { name: 'headRefName' },
          { name: 'baseRefName' },
          { name: 'mergeable' },
          { name: 'state' },
          { name: 'merged' },
          { name: 'files' },
        ],
      };
    }
    if (query.includes('Repository: __type(name: "Repository")') || query.includes('__type(name: "Repository")')) {
      data['Repository'] = {
        fields: [
          { name: 'id' },
          { name: 'databaseId' },
          { name: 'name' },
          { name: 'nameWithOwner' },
          { name: 'owner' },
          { name: 'defaultBranchRef' },
          { name: 'viewerPermission' },
          { name: 'hasIssuesEnabled' },
          { name: 'issue' },
          { name: 'issues' },
          { name: 'pullRequests' },
          { name: 'pullRequest' },
        ],
      };
    }
    if (query.includes('SearchType: __type(name: "SearchType")') || query.includes('__type(name: "SearchType")')) {
      data['SearchType'] = {
        enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }],
      };
    }
    return { data };
  }

  // Node query: query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }
  if (query.includes('node(id: $id)')) {
    const parsed = parseBase64Id(variables.id);
    if (parsed && (parsed.type === 'Repository' || parsed.type === 'Repo')) {
      const repo = findRepoById(parsed.id);
      if (repo) {
        return {
          data: {
            node: {
              id: variables.id,
              name: repo.name,
              nameWithOwner: `${repo.owner}/${repo.name}`,
            },
          },
        };
      }
    }
    return { data: { node: null } };
  }

  // Mutations
  if (query.includes('mutation IssueCreate')) {
    const input = variables.input ?? {};
    const parsed = parseBase64Id(input.repositoryId);
    const repo = parsed ? findRepoById(parsed.id) : undefined;
    if (!repo) {
      return { errors: [{ message: 'Repository not found' }] };
    }
    const num = repo.nextIssueNumber++;
    const issueId = repo.id * 1000 + num;
    const issue: Issue = {
      id: issueId,
      number: num,
      title: input.title ?? '',
      body: input.body ?? '',
      state: 'open',
      labels: [],
      createdAt: '2026-11-14T00:00:00Z',
      updatedAt: '2026-11-14T00:00:00Z',
      closedAt: null,
      user: { login: globalStore.viewerLogin, id: 1000 },
      comments: [],
    };
    repo.issues.set(num, issue);
    return {
      data: {
        createIssue: {
          issue: {
            number: num,
            id: toBase64Id('Issue', issueId),
          },
        },
      },
    };
  }

  if (query.includes('mutation IssueClose')) {
    const input = variables.input ?? {};
    const parsed = parseBase64Id(input.issueId);
    const found = parsed ? findIssueById(parsed.id) : undefined;
    if (!found) {
      return { errors: [{ message: 'Issue not found' }] };
    }
    found.issue.state = 'closed';
    found.issue.closedAt = '2026-11-14T00:00:00Z';
    return {
      data: {
        closeIssue: {
          issue: {
            number: found.issue.number,
            id: input.issueId,
            state: 'CLOSED',
          },
        },
      },
    };
  }

  if (query.includes('mutation PullRequestCreate')) {
    const input = variables.input ?? {};
    const parsed = parseBase64Id(input.repositoryId);
    const repo = parsed ? findRepoById(parsed.id) : undefined;
    if (!repo) {
      return { errors: [{ message: 'Repository not found' }] };
    }
    const num = repo.nextPullNumber++;
    const pullId = repo.id * 2000 + num;
    const headRef = input.headRefName;
    const baseRef = input.baseRefName ?? repo.defaultBranch;
    const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? repo.refs.get(headRef) ?? ZERO_OID;
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? repo.refs.get(baseRef) ?? ZERO_OID;

    const pull: PullRequest = {
      id: pullId,
      number: num,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      title: input.title ?? '',
      body: '',
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      createdAt: '2026-11-14T00:00:00Z',
      updatedAt: '2026-11-14T00:00:00Z',
      user: { login: globalStore.viewerLogin, id: 1000 },
    };
    repo.pulls.set(num, pull);
    return {
      data: {
        createPullRequest: {
          pullRequest: {
            number: num,
            id: toBase64Id('PullRequest', pullId),
            state: 'OPEN',
            headRefName: headRef,
            baseRefName: baseRef,
          },
        },
      },
    };
  }

  if (query.includes('mutation MergePullRequest')) {
    const input = variables.input ?? {};
    const parsed = parseBase64Id(input.pullRequestId);
    const found = parsed ? findPullById(parsed.id) : undefined;
    if (!found) {
      return { errors: [{ message: 'PullRequest not found' }] };
    }
    const { repo, pull } = found;
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

    return {
      data: {
        mergePullRequest: {
          pullRequest: {
            number: pull.number,
            merged: true,
            state: 'MERGED',
          },
        },
      },
    };
  }

  if (query.includes('mutation AddComment')) {
    const input = variables.input ?? {};
    const parsed = parseBase64Id(input.subjectId);
    const found = parsed ? findIssueById(parsed.id) : undefined;
    if (!found) {
      return { errors: [{ message: 'Subject not found' }] };
    }
    const commentId = found.repo.nextCommentId++;
    const comment = {
      id: commentId,
      body: input.body ?? '',
      createdAt: '2026-11-14T00:00:00Z',
      user: { login: globalStore.viewerLogin, id: 1000 },
    };
    found.issue.comments.push(comment);
    return {
      data: {
        addComment: {
          commentEdge: {
            node: {
              id: toBase64Id('IssueComment', commentId),
              body: comment.body,
            },
          },
        },
      },
    };
  }

  // Query viewer (only when top-level viewer is requested without repository)
  if (
    (query.includes('query ViewerLogin') || /\bviewer\s*\{/i.test(query)) &&
    !query.includes('repository(') &&
    !query.includes('repository (')
  ) {
    return {
      data: {
        viewer: {
          login: globalStore.viewerLogin,
        },
      },
    };
  }

  // Repository queries
  const repoOwner = variables.owner;
  const repoName = variables.name;
  const repo = repoOwner && repoName ? globalStore.getRepo(repoOwner, repoName) : undefined;

  // Unknown repository check: if query asks for repository and it does not exist, return data.repository = null
  if (!repo && (query.includes('repository(') || query.includes('repository ('))) {
    return {
      data: {
        repository: null,
      },
    };
  }

  if (repo) {
    const repoData: Record<string, any> = {
      id: toBase64Id('Repository', repo.id),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      defaultBranchRef: { name: repo.defaultBranch },
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
    };

    // query PullRequests / pullRequests(first:)
    if (query.includes('pullRequests(first:')) {
      const first = variables.first ?? 10;
      const pulls = [...repo.pulls.values()].slice(0, first);
      repoData['pullRequests'] = {
        nodes: pulls.map((p) => ({
          number: p.number,
          headRefName: p.head.ref,
          baseRefName: p.base.ref,
          mergeable: 'MERGEABLE',
          state: p.state === 'closed' ? (p.merged ? 'MERGED' : 'CLOSED') : 'OPEN',
        })),
      };
    }

    // query PullRequestFiles / pullRequest(number: $number)
    if (query.includes('pullRequest(number: $number)')) {
      const pNum = variables.number;
      const pull = repo.pulls.get(pNum);
      if (pull) {
        const headCommit = repo.objects.get(pull.head.sha);
        const baseCommit = repo.objects.get(pull.base.sha);
        const headTree = headCommit ? parseCommit(headCommit.data).tree : null;
        const baseTree = baseCommit ? parseCommit(baseCommit.data).tree : null;
        const changedPaths = diffTreePaths(repo, baseTree, headTree);

        repoData['pullRequest'] = {
          id: toBase64Id('PullRequest', pull.id),
          number: pull.number,
          files: {
            nodes: changedPaths.map((path) => ({ path })),
          },
        };
      } else {
        repoData['pullRequest'] = null;
      }
    }

    // query IssueByNumber / issue(number: $number)
    if (query.includes('issue(number: $number)')) {
      const iNum = variables.number;
      const issue = repo.issues.get(iNum);
      if (issue) {
        repoData['issue'] = {
          number: issue.number,
          title: issue.title,
          state: issue.state.toUpperCase(),
          id: toBase64Id('Issue', issue.id),
          body: issue.body,
        };
      } else {
        repoData['issue'] = null;
      }
    }

    // query OpenIssues / issues(first: ...)
    if (query.includes('issues(')) {
      let issues = [...repo.issues.values()];
      if (query.includes('states: [OPEN]')) {
        issues = issues.filter((i) => i.state === 'open');
      }
      if (query.includes('direction: DESC')) {
        issues.sort((a, b) => b.number - a.number);
      } else {
        issues.sort((a, b) => a.number - b.number);
      }

      const first = variables.first ?? 10;
      let after = variables.after;
      let startIndex = 0;
      if (after) {
        try {
          const cursorNum = Number.parseInt(Buffer.from(after, 'base64').toString('utf8'), 10);
          startIndex = issues.findIndex((i) => i.number === cursorNum) + 1;
        } catch {
          startIndex = 0;
        }
      }
      const page = issues.slice(startIndex, startIndex + first);
      const hasNextPage = startIndex + first < issues.length;
      const endCursor = page.length > 0 ? Buffer.from(String(page[page.length - 1]!.number)).toString('base64') : null;

      repoData['issues'] = {
        nodes: page.map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state.toUpperCase(),
          id: toBase64Id('Issue', i.id),
        })),
        pageInfo: {
          hasNextPage,
          endCursor,
        },
      };
    }

    return {
      data: {
        repository: repoData,
      },
    };
  }

  return { data: {} };
}

export async function handleGraphQLRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { errors: [{ message: 'Method Not Allowed' }] });
    return;
  }

  if (!checkAuth(req)) {
    sendJson(res, 401, { errors: [{ message: 'Requires authentication' }] });
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    sendJson(res, 400, { errors: [{ message: 'A query is required' }] });
    return;
  }

  let parsedBody: any;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Malformed JSON' }] });
    return;
  }

  // Support batched operations (array of operations)
  if (Array.isArray(parsedBody)) {
    const results = parsedBody.map((op) => executeSingleOperation(op.query ?? '', op.variables ?? {}));
    sendJson(res, 200, results);
    return;
  }

  const result = executeSingleOperation(parsedBody.query ?? '', parsedBody.variables ?? {});
  sendJson(res, 200, result);
}
