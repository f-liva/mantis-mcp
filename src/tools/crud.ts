import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MantisClient } from "../mantis-client.js";

/** Read local file paths into Mantis file payloads (base64). */
function filesToPayload(
  paths: string[]
): Array<{ name: string; content: string }> {
  return paths.map((p) => ({
    name: basename(p),
    content: readFileSync(p).toString("base64"),
  }));
}

export function registerCrudTools(
  server: McpServer,
  client: MantisClient
): void {
  // ── get_issues ─────────────────────────────────────────────────────
  server.tool(
    "get_issues",
    "List issues with optional filters and pagination",
    {
      page: z.number().int().positive().optional().describe("Page number (default 1)"),
      page_size: z.number().int().positive().max(200).optional().describe("Items per page (default 50, max 200)"),
      project_id: z.number().int().positive().optional().describe("Filter by project ID"),
      filter_id: z.number().int().positive().optional().describe("MantisBT saved filter ID"),
      select: z.string().optional().describe("Comma-separated fields to select"),
    },
    async (params) => {
      try {
        const result = await client.getIssues({
          page: params.page ?? 1,
          page_size: params.page_size ?? 50,
          project_id: params.project_id,
          filter_id: params.filter_id,
          select: params.select,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching issues: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_issue_by_id ────────────────────────────────────────────────
  server.tool(
    "get_issue_by_id",
    "Get full details of an issue by its ID",
    {
      id: z.number().int().positive().describe("Issue ID"),
    },
    async ({ id }) => {
      try {
        const issue = await client.getIssue(id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(issue, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching issue #${id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── create_issue ───────────────────────────────────────────────────
  server.tool(
    "create_issue",
    "Create a new issue in MantisBT. The issue is assigned right away: unless a different handler is given it goes to the API user, with status 'assigned'.",
    {
      summary: z.string().describe("Issue summary/title"),
      description: z.string().describe("Issue description"),
      project_id: z.number().int().positive().describe("Project ID"),
      category: z.string().optional().describe("Category name"),
      priority: z.string().optional().describe("Priority name (e.g. 'normal', 'high', 'urgent')"),
      severity: z.string().optional().describe("Severity name"),
      handler: z.string().optional().describe("Handler username (default: the API user, so the issue starts as 'assigned')"),
      reporter: z.string().optional().describe("Reporter: username OR full/partial real name (resolved by searching the project's known users). Requires admin to set someone other than the API user."),
      reporter_email: z.string().email().optional().describe("Email of the reporter. When the reporter has no Mantis account yet (e.g. the sender of the source email), pass it and the account is created automatically: disabled, random password, access level 'reporter' - a label only, no login and no welcome mail."),
      reporter_real_name: z.string().optional().describe("Full name of the reporter, used when the account has to be created (default: the username)"),
      tags: z.array(z.string()).optional().describe("Tag names"),
      view_state: z.enum(["public", "private"]).optional().describe("Visibility (default: public). 'private' = visible only to the reporter and project managers/devs."),
      files: z.array(z.string()).optional().describe("Local file paths to attach to the issue (e.g. the .eml of the source email conversation)"),
    },
    async (params) => {
      try {
        const data: Parameters<MantisClient["createIssue"]>[0] = {
          summary: params.summary,
          description: params.description,
          project: { id: params.project_id },
        };
        if (params.category) data.category = { name: params.category };
        if (params.priority) data.priority = { name: params.priority };
        if (params.severity) data.severity = { name: params.severity };
        if (params.view_state) data.view_state = { name: params.view_state };
        // assigned to someone from the start, never left hanging as "new"
        data.handler = { name: params.handler ?? (await client.getMe()).name };
        data.status = { name: "assigned" };

        let createdUserNote = "";
        if (params.reporter) {
          const r = await client.resolveUser(params.reporter, params.project_id);
          if (!r.user && !r.candidates && params.reporter_email) {
            // unknown reporter (typically the sender of the source email):
            // give them a disabled placeholder account so the issue can be
            // attributed to them
            const username = /^[a-z0-9._-]+$/i.test(params.reporter)
              ? params.reporter
              : params.reporter_email.split("@")[0].replace(/[^a-z0-9._-]/gi, "");
            const created = await client.createUser({
              username,
              real_name: params.reporter_real_name ?? params.reporter,
              email: params.reporter_email,
            });
            createdUserNote = `\n\n[created user] ${created.name} (disabled, reporter level) for ${params.reporter_email}`;
            data.reporter = { name: created.name };
          }
          if (r.candidates) {
            const list = r.candidates
              .map((u) => `- ${u.name} (${u.real_name}, ${u.email})`)
              .join("\n");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Ambiguous reporter "${params.reporter}". Candidates:\n${list}\nRe-run with an exact username.`,
                },
              ],
              isError: true,
            };
          }
          // resolved -> exact username; otherwise pass the raw string and let
          // the API try to match it (e.g. an exact username not seen in issues).
          if (!data.reporter) {
            data.reporter = { name: r.user ? r.user.name : params.reporter };
          }
        }
        if (params.tags) data.tags = params.tags.map((name) => ({ name }));

        const issue = await client.createIssue(data);

        let attachNote = "";
        if (params.files?.length) {
          try {
            await client.addFiles(issue.id, filesToPayload(params.files));
            attachNote = `\n\n[attached] ${params.files.map((p) => basename(p)).join(", ")}`;
          } catch (e) {
            attachNote = `\n\n[attach failed] ${e instanceof Error ? e.message : String(e)}`;
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(issue, null, 2) + createdUserNote + attachNote,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error creating issue: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── add_issue_file ─────────────────────────────────────────────────
  server.tool(
    "add_issue_file",
    "Allega file a livello ISSUE: l'allegato e' SEMPRE PUBBLICO (nessun view_state), non e' legato ad alcuna nota e NON e' eliminabile via API (solo dalla UI). Usalo solo per allegati pubblici svincolati da una nota (es. la .eml di un thread). Per allegati riservati o che accompagnano una nota, usa add_issue_note con file_paths.",
    {
      issue_id: z.number().int().positive().describe("Issue ID"),
      paths: z.array(z.string()).min(1).describe("Local file paths to attach"),
    },
    async ({ issue_id, paths }) => {
      try {
        await client.addFiles(issue_id, filesToPayload(paths));
        return {
          content: [
            {
              type: "text" as const,
              text: `Attached to issue #${issue_id}: ${paths.map((p) => basename(p)).join(", ")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error attaching files to issue #${issue_id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── download_issue_file ────────────────────────────────────────────
  server.tool(
    "download_issue_file",
    "Download an attachment from an issue to local disk. Get issue_id + file_id from get_issue_by_id (attachments[].id). Returns the saved absolute path.",
    {
      issue_id: z.number().int().positive().describe("Issue ID"),
      file_id: z.number().int().positive().describe("Attachment file ID (from issue.attachments[].id)"),
      save_dir: z
        .string()
        .optional()
        .describe("Destination directory (default ~/Scaricati/mantis-attachments)"),
    },
    async ({ issue_id, file_id, save_dir }) => {
      try {
        const f = await client.getFile(issue_id, file_id);
        const dir = save_dir
          ? isAbsolute(save_dir)
            ? save_dir
            : resolve(save_dir)
          : join(homedir(), "Scaricati", "mantis-attachments");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, basename(f.filename));
        writeFileSync(path, Buffer.from(f.content, "base64"));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { path, filename: f.filename, size: f.size, content_type: f.content_type },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error downloading file #${file_id} from issue #${issue_id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── update_issue ───────────────────────────────────────────────────
  server.tool(
    "update_issue",
    "Update an existing issue",
    {
      id: z.number().int().positive().describe("Issue ID to update"),
      summary: z.string().optional().describe("New summary"),
      description: z.string().optional().describe("New description"),
      status: z.string().optional().describe("New status name"),
      priority: z.string().optional().describe("New priority name"),
      severity: z.string().optional().describe("New severity name"),
      handler: z.string().optional().describe("New handler username"),
      category: z.string().optional().describe("New category name"),
    },
    async (params) => {
      try {
        const { id, ...fields } = params;
        const data: Record<string, unknown> = {};
        if (fields.summary) data.summary = fields.summary;
        if (fields.description) data.description = fields.description;
        if (fields.status) data.status = { name: fields.status };
        if (fields.priority) data.priority = { name: fields.priority };
        if (fields.severity) data.severity = { name: fields.severity };
        if (fields.handler) data.handler = { name: fields.handler };
        if (fields.category) data.category = { name: fields.category };

        const issue = await client.updateIssue(id, data);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(issue, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error updating issue #${params.id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── add_issue_note ─────────────────────────────────────────────────
  server.tool(
    "add_issue_note",
    "Add a note/comment to an issue. Con file_paths gli allegati sono LEGATI alla nota ed ereditano il suo view_state: una nota private con file_paths produce un allegato PRIVATO (invisibile al cliente) e rimovibile eliminando la nota. Preferire QUESTO ad add_issue_file per ogni allegato riservato o che deve accompagnare una nota.",
    {
      issue_id: z.number().int().positive().describe("Issue ID"),
      text: z.string().describe("Note text content"),
      view_state: z.enum(["public", "private"]).optional().describe("Visibility (default: public)"),
      file_paths: z
        .array(z.string())
        .optional()
        .describe(
          "Percorsi locali di file da allegare INLINE alla nota. L'allegato eredita il view_state della nota (privato se la nota e' privata) ed e' legato ad essa (sparisce con delete_issue_note). Usa questo, non add_issue_file, per allegati riservati."
        ),
    },
    async (params) => {
      try {
        const noteData: {
          text: string;
          view_state?: { name: string };
          files?: Array<{ name: string; content: string }>;
        } = {
          text: params.text,
        };
        if (params.view_state) {
          noteData.view_state = { name: params.view_state };
        }
        if (params.file_paths && params.file_paths.length > 0) {
          noteData.files = filesToPayload(params.file_paths);
        }
        const note = await client.addNote(params.issue_id, noteData);

        // Auto-feedback: una risposta PUBBLICA sposta la issue su "feedback"
        // (palla al reporter; con reassign_on_feedback torna ad assigned quando
        // risponde). Best-effort: non deve far fallire l'aggiunta della nota.
        // Anche una issue "resolved" viene RIAPERTA in feedback: se rispondiamo
        // vuol dire che la discussione e' ancora aperta, e la risoluzione spetta
        // comunque al cliente. Skip solo se gia in feedback o se chiusa
        // (closed = archiviata, non si tocca).
        const isPublic = !params.view_state || params.view_state === "public";
        let autoFeedback: string | null = null;
        if (isPublic) {
          try {
            const cur = await client.getIssue(params.issue_id);
            const st = cur?.status?.name;
            if (st && !["closed", "feedback"].includes(st)) {
              // La PATCH su Mantis richiede una categoria valida: rimandiamo quella corrente.
              const patch: Record<string, unknown> = { status: { name: "feedback" } };
              if (cur?.category?.name) {
                patch.category = { name: cur.category.name };
              }
              await client.updateIssue(params.issue_id, patch);
              autoFeedback =
                st === "resolved"
                  ? 'status -> feedback (riaperta: era "resolved")'
                  : `status -> feedback (era "${st}")`;
            } else {
              autoFeedback = `status invariato ("${st ?? "?"}")`;
            }
          } catch (e) {
            autoFeedback = `auto-feedback non applicato: ${e instanceof Error ? e.message : String(e)}`;
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(note, null, 2) + (autoFeedback ? `\n\n[auto] ${autoFeedback}` : ""),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error adding note to issue #${params.issue_id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── delete_issue_note ──────────────────────────────────────────────
  server.tool(
    "delete_issue_note",
    "Delete a note from an issue. IRREVERSIBILE. Non esiste un update della nota nell'API Mantis: per correggere una nota, eliminala e riaggiungila con add_issue_note (nuovo id/timestamp).",
    {
      issue_id: z.number().int().positive().describe("Issue ID che contiene la nota"),
      note_id: z.number().int().positive().describe("Note ID da eliminare"),
    },
    async (params) => {
      try {
        await client.deleteNote(params.issue_id, params.note_id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Nota #${params.note_id} eliminata.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error deleting note #${params.note_id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_projects ───────────────────────────────────────────────────
  server.tool(
    "get_projects",
    "List all accessible projects",
    {},
    async () => {
      try {
        const projects = await client.getProjects();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(projects, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching projects: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_user ───────────────────────────────────────────────────────
  server.tool(
    "get_user",
    "Look up a user by username",
    {
      username: z.string().describe("Username to look up"),
    },
    async ({ username }) => {
      try {
        const user = await client.getUser(username);
        if (!user) {
          return {
            content: [
              {
                type: "text" as const,
                text: `User "${username}" not found.`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(user, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error looking up user "${username}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_users_by_project_id ────────────────────────────────────────
  server.tool(
    "get_users_by_project_id",
    "List users/members of a project",
    {
      project_id: z.number().int().positive().describe("Project ID"),
    },
    async ({ project_id }) => {
      try {
        const users = await client.getUsersByProjectId(project_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(users, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching users for project #${project_id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
