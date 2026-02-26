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
}
