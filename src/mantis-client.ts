import axios, { type AxiosInstance } from "axios";
import type { Config } from "./config.js";
import { logger } from "./logger.js";

// ── MantisBT API types ──────────────────────────────────────────────

export interface MantisRef {
  id: number;
  name: string;
}

export interface MantisIssueHeader {
  id: number;
  summary: string;
  updated_at: string;
  created_at: string;
  project: MantisRef;
}

export interface MantisNote {
  id: number;
  reporter: MantisRef;
  text: string;
  created_at: string;
  updated_at: string;
  view_state: MantisRef;
}

export interface MantisIssue {
  id: number;
  summary: string;
  description: string;
  project: MantisRef;
  category: MantisRef;
  status: MantisRef;
  resolution: MantisRef;
  priority: MantisRef;
  severity: MantisRef;
  reproducibility?: MantisRef;
  reporter: MantisRef;
  handler?: MantisRef;
  created_at: string;
  updated_at: string;
  notes?: MantisNote[];
  tags?: MantisRef[];
  custom_fields?: Array<{ field: MantisRef; value: string }>;
}

export interface MantisProject {
  id: number;
  name: string;
  status: MantisRef;
  description: string;
  enabled: boolean;
  access_level: MantisRef;
}

export interface MantisUser {
  id: number;
  name: string;
  real_name: string;
  email: string;
}

// ── Client ──────────────────────────────────────────────────────────

export class MantisClient {
  private api: AxiosInstance;

  constructor(config: Config) {
    this.api = axios.create({
      baseURL: config.MANTIS_API_URL,
      headers: {
        Authorization: config.MANTIS_API_KEY,
        "Content-Type": "application/json",
        // Cloudflare davanti a debug.espero.it risponde 403 (error 1010) se lo
        // User-Agent e' quello di default di axios/node. Un UA browser bypassa
        // il blocco. Vedi anche il workaround documentato per le chiamate dirette.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      timeout: 30000,
    });
  }

  /** Fetch all issue headers (lightweight) for sync — paginated */
  async fetchAllIssueHeaders(
    projectId?: number
  ): Promise<MantisIssueHeader[]> {
    const all: MantisIssueHeader[] = [];
    let page = 1;
    const pageSize = 200;

    while (true) {
      const params: Record<string, unknown> = {
        page_size: pageSize,
        page,
        select: "id,summary,updated_at,created_at,project",
      };
      if (projectId) params.project_id = projectId;

      const resp = await this.api.get<{ issues: MantisIssueHeader[] }>(
        "/issues",
        { params }
      );
      const issues = resp.data.issues ?? [];
      all.push(...issues);
      logger.debug(
        `Fetched page ${page}: ${issues.length} headers (total: ${all.length})`
      );

      if (issues.length < pageSize) break;
      page++;
    }

    return all;
  }

  /** Fetch paginated issues with optional filters */
  async getIssues(params: {
    page?: number;
    page_size?: number;
    project_id?: number;
    filter_id?: number;
    select?: string;
  }): Promise<{ issues: MantisIssue[] }> {
    const resp = await this.api.get<{ issues: MantisIssue[] }>("/issues", {
      params,
    });
    return resp.data;
  }

  /** Fetch a single issue by ID with full details */
  async getIssue(id: number): Promise<MantisIssue> {
    const resp = await this.api.get<{ issues: MantisIssue[] }>(
      `/issues/${id}`
    );
    return resp.data.issues[0];
  }

  /** Create a new issue */
  async createIssue(data: {
    summary: string;
    description: string;
    project: { id: number };
    category?: { name: string };
    priority?: { name: string };
    severity?: { name: string };
    handler?: { name: string };
    reporter?: { name: string };
    tags?: Array<{ name: string }>;
  }): Promise<MantisIssue> {
    const resp = await this.api.post<{ issue: MantisIssue }>("/issues", data);
    return resp.data.issue;
  }

  /** Update an existing issue */
  async updateIssue(
    id: number,
    data: Record<string, unknown>
  ): Promise<MantisIssue> {
    const resp = await this.api.patch<{ issues: MantisIssue[] }>(
      `/issues/${id}`,
      data
    );
    return resp.data.issues[0];
  }

  /** Attach one or more files (base64 content) to an issue */
  async addFiles(
    issueId: number,
    files: Array<{ name: string; content: string }>
  ): Promise<unknown> {
    const resp = await this.api.post(`/issues/${issueId}/files`, { files });
    return resp.data;
  }

  /** Add a note to an issue */
  async addNote(
    issueId: number,
    data: { text: string; view_state?: { name: string } }
  ): Promise<MantisNote> {
    const resp = await this.api.post<{ note: MantisNote }>(
      `/issues/${issueId}/notes`,
      data
    );
    return resp.data.note;
  }

  /** List all projects */
  async getProjects(): Promise<MantisProject[]> {
    const resp = await this.api.get<{ projects: MantisProject[] }>(
      "/projects"
    );
    return resp.data.projects ?? [];
  }

  /** Look up a user by username */
  async getUser(username: string): Promise<MantisUser | null> {
    try {
      const resp = await this.api.get<MantisUser[]>(`/users`, {
        params: { username },
      });
      const users = Array.isArray(resp.data) ? resp.data : [];
      return users.length > 0 ? users[0] : null;
    } catch {
      return null;
    }
  }

  /** List users for a specific project */
  async getUsersByProjectId(projectId: number): Promise<MantisUser[]> {
    const resp = await this.api.get<MantisUser[]>(
      `/projects/${projectId}/users`
    );
    return Array.isArray(resp.data) ? resp.data : [];
  }

  /**
   * Derive the distinct users seen in a project's issues (reporters + handlers).
   * The MantisBT REST API on debug.espero.it has no usable /users endpoint
   * (GET returns 405), so this is the only way to resolve a user from a free
   * text name. ponytail: scans up to 4 pages (~800 issues); a user who never
   * reported/handled an issue in that window won't be found — fall back to
   * passing an exact username if so.
   */
  async findProjectUsers(projectId: number): Promise<MantisUser[]> {
    const map = new Map<number, MantisUser>();
    const pageSize = 200;
    for (let page = 1; page <= 4; page++) {
      const resp = await this.api.get<{ issues: MantisIssue[] }>("/issues", {
        params: {
          project_id: projectId,
          page_size: pageSize,
          page,
          select: "id,reporter,handler",
        },
      });
      const issues = resp.data.issues ?? [];
      for (const it of issues) {
        for (const u of [it.reporter, it.handler]) {
          // only entries carrying a real_name are full MantisUser objects
          if (u && u.id && (u as MantisUser).real_name !== undefined) {
            map.set(u.id, u as unknown as MantisUser);
          }
        }
      }
      if (issues.length < pageSize) break;
    }
    return [...map.values()];
  }

  /**
   * Resolve a user from a free-text query: exact username, or a partial match
   * on username / real name / email (case-insensitive). Returns the single
   * match, or the candidate list when ambiguous, or null when none found.
   */
  async resolveUser(
    query: string,
    projectId: number
  ): Promise<{ user?: MantisUser; candidates?: MantisUser[] }> {
    const q = query.trim().toLowerCase();
    const users = await this.findProjectUsers(projectId);

    const exact = users.filter((u) => (u.name ?? "").toLowerCase() === q);
    if (exact.length === 1) return { user: exact[0] };

    const partial = users.filter(
      (u) =>
        (u.name ?? "").toLowerCase().includes(q) ||
        (u.real_name ?? "").toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q)
    );
    if (partial.length === 1) return { user: partial[0] };
    if (partial.length > 1) return { candidates: partial };
    return {};
  }
}
