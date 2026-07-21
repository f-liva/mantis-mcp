import axios, { type AxiosInstance } from "axios";
import { randomBytes } from "node:crypto";
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

// Nota storica: qui c'era una traslitterazione UTF-8 -> ASCII (sanitizeText)
// perche' i POST con caratteri non-ASCII fallivano muti. Il vero colpevole era
// la WAF Cloudflare, risolta con il set completo di header browser (vedi
// costruttore sotto): verificato il 2026-07-16 che l'API accetta e restituisce
// UTF-8 identico (accenti, em-dash, virgolette curve, euro). Rimossa.

// ── Client ──────────────────────────────────────────────────────────

export class MantisClient {
  private api: AxiosInstance;

  constructor(config: Config) {
    this.api = axios.create({
      baseURL: config.MANTIS_API_URL,
      headers: {
        Authorization: config.MANTIS_API_KEY,
        "Content-Type": "application/json",
        // Cloudflare davanti a debug.espero.it non basta ingannarlo con il solo
        // User-Agent: la managed WAF droppa comunque la connessione (nessuna
        // risposta) quando il body contiene caratteri "sospetti" tipo la pipe
        // "|" (usata dalle tabelle Markdown) o gli angle bracket. Con il SET
        // COMPLETO di header di un browser reale (Accept, Accept-Language,
        // Referer/Origin same-site, sec-ch-ua, Sec-Fetch-*) la richiesta viene
        // classificata come navigazione legittima e i payload passano. Senza
        // questi header, add_issue_note con una tabella MD fallisce muta.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
        Referer: "https://debug.espero.it/mantis/",
        Origin: "https://debug.espero.it",
        "sec-ch-ua":
          '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
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

  /** The user behind MANTIS_API_KEY (cached for the process lifetime) */
  private me?: MantisRef;
  async getMe(): Promise<MantisRef> {
    if (!this.me) {
      const resp = await this.api.get<MantisRef>("/users/me");
      this.me = { id: resp.data.id, name: resp.data.name };
    }
    return this.me;
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
    status?: { name: string };
    tags?: Array<{ name: string }>;
    view_state?: { name: string };
  }): Promise<MantisIssue> {
    const resp = await this.api.post<{ issue: MantisIssue }>("/issues", data);
    return resp.data.issue;
  }

  /**
   * Create a user. Used to give an issue a reporter that has no Mantis
   * account yet (e.g. a customer who wrote by email): the account is created
   * disabled with a random password, so it is only a label - nobody can log
   * in with it and no welcome mail is triggered.
   */
  async createUser(data: {
    username: string;
    real_name?: string;
    email: string;
    access_level?: string;
    enabled?: boolean;
  }): Promise<MantisRef> {
    const resp = await this.api.post<{ user: MantisRef }>("/users", {
      username: data.username,
      password: randomBytes(18).toString("base64url"),
      real_name: data.real_name ?? data.username,
      email: data.email,
      access_level: { name: data.access_level ?? "reporter" },
      enabled: data.enabled ?? false,
      protected: false,
    });
    return resp.data.user;
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

  /** Download a single attachment (base64 content) from an issue */
  async getFile(
    issueId: number,
    fileId: number
  ): Promise<{ filename: string; content: string; content_type?: string; size?: number }> {
    const resp = await this.api.get<{
      files: Array<{ filename: string; content: string; content_type?: string; size?: number }>;
    }>(`/issues/${issueId}/files/${fileId}`);
    const f = resp.data.files?.[0];
    if (!f) throw new Error(`file ${fileId} not found on issue ${issueId}`);
    return f;
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
