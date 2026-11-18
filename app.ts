// Main HTTP application dispatcher for github-core-clone-01 forge
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { globalStore } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRestRequest, sendJson } from './rest.ts';
import { handleGraphQLRequest } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';

function pathOf(req: IncomingMessage): { pathname: string; search: string } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, search: url.search };
  } catch {
    return { pathname: '/', search: '' };
  }
}

async function readAllBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const { pathname, search } = pathOf(req);
      const method = req.method ?? 'GET';

      // Health probe: GET /healthz
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /:owner/:repo.git/...
      const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
      if (gitMatch) {
        const [, owner, repoName, gitEndpoint] = gitMatch;
        const repo = globalStore.getRepo(owner!, repoName!);

        if (gitEndpoint === 'info/refs') {
          const query = new URLSearchParams(search);
          const service = query.get('service') ?? '';
          if (!repo) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Repository not found\n');
            return;
          }
          handleInfoRefs(req, res, repo, service);
          return;
        }

        if (gitEndpoint === 'git-upload-pack') {
          if (!repo) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Repository not found\n');
            return;
          }
          const bodyBuffer = await readAllBytes(req);
          handleUploadPack(req, res, repo, bodyBuffer);
          return;
        }

        if (gitEndpoint === 'git-receive-pack') {
          if (!repo) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Repository not found\n');
            return;
          }
          const bodyBuffer = await readAllBytes(req);
          handleReceivePack(req, res, repo, bodyBuffer);
          return;
        }
      }

      // REST v3 API: /api/v3/...
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        await handleRestRequest(req, res);
        return;
      }

      // GraphQL v4: /api/graphql
      if (pathname === '/api/graphql') {
        await handleGraphQLRequest(req, res);
        return;
      }

      // Model Context Protocol: /mcp
      if (pathname === '/mcp') {
        await handleMcpRequest(req, res);
        return;
      }

      // Unknown route: 404 JSON with X-GitHub-Request-Id
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      try {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // Response already ended
      }
    }
  });
}
