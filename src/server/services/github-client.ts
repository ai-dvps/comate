/**
 * Octokit-backed {@link GithubBackendAdapter} — the first (and v1 only)
 * implementation of the pluggable backend seam (KTD2/KTD8).
 *
 * This is the ONLY module that imports `@octokit/*`. Pagination, secondary
 * rate-limit backoff, and transient-5xx retry are delegated to the throttling
 * and retry plugins — the bulk of the sync risk surface that reimplementing in
 * raw fetch would concentrate bugs into (KTD2 rationale). ETag 304 short-
 * circuits the no-change refresh so on-demand sync does not burn the 5000/hr
 * budget.
 *
 * SECURITY (R13): this adapter throws raw octokit errors; every catch site that
 * can reach a logger or response wraps them in `redactGithubError`. 404s on
 * `getIssue`/`listChanged` are swallowed into `null`/empty so the sync engine
 * can detect origin-side deletion (U5) without an exception path.
 */
import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { retry } from '@octokit/plugin-retry';
import type {
  GithubBackendAdapter,
  GithubRepo,
  RemoteIssue,
  RemoteComment,
  ListChangedResult,
  CreateIssueInput,
  UpdateIssueInput,
} from './github-types.js';

const ThrottledOctokit = Octokit.plugin(throttling, retry);

/** Factory type so tests can swap in a fake adapter without touching octokit. */
export type OctokitAdapterFactory = (token: string) => GithubBackendAdapter;

/** Minimal subset of the octokit issue shape that the mappers read. */
interface OctokitIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  assignee: { login: string } | null;
  labels: Array<{ name: string } | string>;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}
interface OctokitComment {
  id: number;
  user: { login: string } | null;
  body: string | null;
  created_at: string;
  updated_at: string;
}
interface OctokitRepo {
  full_name: string;
  private: boolean;
  default_branch: string | null;
}

function parseRepo(repo: string): [owner: string, name: string] {
  const idx = repo.indexOf('/');
  if (idx <= 0 || idx >= repo.length - 1) {
    throw new Error(`Invalid repository full name: "${repo}" (expected "owner/repo")`);
  }
  return [repo.slice(0, idx), repo.slice(idx + 1)];
}

function mapIssue(i: OctokitIssue): RemoteIssue {
  const labels = (i.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((l): l is string => typeof l === 'string');
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? null,
    state: i.state,
    assignee: i.assignee?.login ?? null,
    labels,
    updatedAt: i.updated_at,
    htmlUrl: i.html_url,
  };
}

function mapComment(c: OctokitComment): RemoteComment {
  return {
    id: c.id,
    author: c.user?.login ?? 'unknown',
    body: c.body ?? '',
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function mapRepo(r: OctokitRepo): GithubRepo {
  return {
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch ?? null,
  };
}

/** Build a {@link GithubBackendAdapter} backed by octokit for the given token. */
export function createOctokitAdapter(token: string): GithubBackendAdapter {
  const octokit = new ThrottledOctokit({
    auth: token,
    throttle: {
      // Retry once on primary (403/429) and secondary rate limits, then give up.
      onRateLimit: (_retryAfter: number, _options: unknown, _octokit: unknown, retryCount: number) => retryCount < 1,
      onSecondaryRateLimit: (_retryAfter: number, _options: unknown, _octokit: unknown, retryCount: number) =>
        retryCount < 1,
    },
    retry: { retries: 2 },
  });

  return {
    async listAccessibleRepos(): Promise<GithubRepo[]> {
      const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, { per_page: 100 });
      return (repos as unknown as OctokitRepo[]).map(mapRepo);
    },

    async listChanged(repo: string, since: string | null, etag: string | null): Promise<ListChangedResult> {
      const [owner, name] = parseRepo(repo);
      let resp;
      try {
        resp = await octokit.request('GET /repos/{owner}/{repo}/issues', {
          owner,
          repo: name,
          since: since ?? undefined,
          state: 'all',
          per_page: 100,
          headers: etag ? { 'If-None-Match': etag } : undefined,
        });
      } catch (err) {
        // ETag 304 (no change): octokit throws it rather than resolving it. Treat
        // it as a clean short-circuit so on-demand sync does not burn the budget.
        if ((err as { status?: number }).status === 304) {
          return { issues: [], etag, latestUpdatedAt: null, notModified: true };
        }
        throw err;
      }
      const data = (resp.data as unknown as OctokitIssue[]).filter((i) => !i.pull_request).map(mapIssue);
      const newEtag = (resp.headers as { etag?: string }).etag ?? null;
      const latestUpdatedAt = data.reduce<string | null>(
        (max, i) => (max === null || i.updatedAt > max ? i.updatedAt : max),
        null,
      );
      return { issues: data, etag: newEtag, latestUpdatedAt };
    },

    async getIssue(repo: string, number: number): Promise<RemoteIssue | null> {
      const [owner, name] = parseRepo(repo);
      try {
        const { data } = await octokit.rest.issues.get({ owner, repo: name, issue_number: number });
        return mapIssue(data as unknown as OctokitIssue);
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null;
        throw err;
      }
    },

    async create(repo: string, input: CreateIssueInput): Promise<RemoteIssue> {
      const [owner, name] = parseRepo(repo);
      const { data } = await octokit.rest.issues.create({
        owner,
        repo: name,
        title: input.title,
        body: input.body ?? undefined,
        labels: input.labels,
        assignees: input.assignees,
      });
      return mapIssue(data as unknown as OctokitIssue);
    },

    async update(repo: string, number: number, input: UpdateIssueInput): Promise<RemoteIssue> {
      const [owner, name] = parseRepo(repo);
      const { data } = await octokit.rest.issues.update({
        owner,
        repo: name,
        issue_number: number,
        title: input.title,
        body: input.body,
        state: input.state,
        labels: input.labels,
        assignees: input.assignees,
      });
      return mapIssue(data as unknown as OctokitIssue);
    },

    async fetchComments(repo: string, number: number): Promise<RemoteComment[]> {
      const [owner, name] = parseRepo(repo);
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo: name,
        issue_number: number,
        per_page: 100,
      });
      return (comments as unknown as OctokitComment[]).map(mapComment);
    },

    async addComment(repo: string, number: number, body: string): Promise<RemoteComment> {
      const [owner, name] = parseRepo(repo);
      const { data } = await octokit.rest.issues.createComment({ owner, repo: name, issue_number: number, body });
      return mapComment(data as unknown as OctokitComment);
    },
  };
}
