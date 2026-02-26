import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MantisClient } from "../mantis-client.js";

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
    "Create a new issue in MantisBT",
    {
      summary: z.string().describe("Issue summary/title"),
      description: z.string().describe("Issue description"),
      project_id: z.number().int().positive().describe("Project ID"),
      category: z.string().optional().describe("Category name"),
      priority: z.string().optional().describe("Priority name (e.g. 'normal', 'high', 'urgent')"),
      severity: z.string().optional().describe("Severity name"),
      handler: z.string().optional().describe("Handler username"),
      tags: z.array(z.string()).optional().describe("Tag names"),
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
        if (params.handler) data.handler = { name: params.handler };
        if (params.tags) data.tags = params.tags.map((name) => ({ name }));

        const issue = await client.createIssue(data);
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
              text: `Error creating issue: ${err instanceof Error ? err.message : String(err)}`,
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
    "Add a note/comment to an issue",
    {
      issue_id: z.number().int().positive().describe("Issue ID"),
      text: z.string().describe("Note text content"),
      view_state: z.enum(["public", "private"]).optional().describe("Visibility (default: public)"),
    },
    async (params) => {
      try {
        const noteData: { text: string; view_state?: { name: string } } = {
          text: params.text,
        };
        if (params.view_state) {
          noteData.view_state = { name: params.view_state };
        }
        const note = await client.addNote(params.issue_id, noteData);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(note, null, 2),
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
