#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFile, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

const TOKEN_URL = "https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token";
const API_BASE = "https://api.access.redhat.com/support/v1";
const CLIENT_ID = "rhsm-api";

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const offlineToken = process.env.REDHAT_TOKEN;
  if (!offlineToken) {
    throw new Error("REDHAT_TOKEN environment variable is required (Red Hat offline API token)");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: offlineToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Expire 60s early to avoid edge cases
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function apiRequest(path, options = {}) {
  const token = await getAccessToken();
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API request failed (${res.status} ${res.statusText}): ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const server = new McpServer({
  name: "mcp-redhat-support",
  version: "1.0.0",
});

// --- Tools ---

server.tool(
  "listCases",
  "List Red Hat support cases with optional filtering",
  {
    accountNumber: z.string().describe("Red Hat account number (required to scope results)"),
    maxResults: z.number().optional().default(10).describe("Maximum number of cases to return"),
    offset: z.number().optional().default(0).describe("Pagination offset"),
    status: z.string().optional().describe("Filter by status (e.g. 'Open', 'Closed', 'Waiting on Customer')"),
    severity: z.string().optional().describe("Filter by severity (e.g. '1 (Urgent)', '2 (High)', '3 (Normal)', '4 (Low)')"),
    searchString: z.string().optional().describe("Search string to filter cases"),
  },
  async ({ accountNumber, maxResults, offset, status, severity, searchString }) => {
    const body = { accountNumber, maxResults, offset };
    if (status) body.status = status;
    if (severity) body.severity = severity;
    if (searchString) body.searchString = searchString;

    const data = await apiRequest("/cases/filter", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool(
  "getCase",
  "Get full details of a specific Red Hat support case",
  {
    caseNumber: z.string().describe("The case number (e.g. '04371920')"),
  },
  async ({ caseNumber }) => {
    const data = await apiRequest(`/cases/${caseNumber}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool(
  "getCaseComments",
  "Get all comments on a Red Hat support case",
  {
    caseNumber: z.string().describe("The case number"),
  },
  async ({ caseNumber }) => {
    const data = await apiRequest(`/cases/${caseNumber}/comments`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool(
  "addCaseComment",
  "Add a comment to a Red Hat support case",
  {
    caseNumber: z.string().describe("The case number"),
    commentBody: z.string().describe("The comment text to add"),
    isPublic: z.boolean().optional().default(true).describe("Whether the comment is visible to Red Hat (true) or internal/private (false)"),
  },
  async ({ caseNumber, commentBody, isPublic }) => {
    const payload = { commentBody, isPublic };
    const data = await apiRequest(`/cases/${caseNumber}/comments`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool(
  "getCaseAttachments",
  "List attachments on a Red Hat support case",
  {
    caseNumber: z.string().describe("The case number"),
  },
  async ({ caseNumber }) => {
    const data = await apiRequest(`/cases/${caseNumber}/attachments`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool(
  "downloadAttachment",
  "Download a case attachment to a local file",
  {
    caseNumber: z.string().describe("The case number"),
    attachmentUuid: z.string().describe("The attachment UUID (from getCaseAttachments)"),
    outputPath: z.string().describe("Local file path to save the attachment to"),
  },
  async ({ caseNumber, attachmentUuid, outputPath }) => {
    const token = await getAccessToken();
    const url = `https://attachments.access.redhat.com/hydra/rest/cases/${caseNumber}/attachments/${attachmentUuid}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Download failed (${res.status}): ${text}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(outputPath, buffer);
    return {
      content: [{ type: "text", text: `Downloaded ${buffer.length} bytes to ${outputPath}` }],
    };
  }
);

server.tool(
  "uploadAttachment",
  "Upload a local file as an attachment to a case",
  {
    caseNumber: z.string().describe("The case number"),
    filePath: z.string().describe("Local file path to upload"),
  },
  async ({ caseNumber, filePath }) => {
    const token = await getAccessToken();
    const fileName = basename(filePath);
    const fileData = await readFile(filePath);
    const fileInfo = await stat(filePath);

    const form = new FormData();
    form.append("file", new Blob([fileData]), fileName);

    const url = `${API_BASE}/cases/${caseNumber}/attachments`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload failed (${res.status}): ${text}`);
    }
    const data = await res.json().catch(() => ({}));
    return {
      content: [{ type: "text", text: `Uploaded ${fileName} (${fileInfo.size} bytes) to case ${caseNumber}\n${JSON.stringify(data, null, 2)}` }],
    };
  }
);

server.tool(
  "createCase",
  "Create a new Red Hat support case",
  {
    summary: z.string().describe("Case summary/title"),
    description: z.string().describe("Detailed description of the issue"),
    product: z.string().describe("Product name (e.g. 'Red Hat Enterprise Linux', 'OpenShift Container Platform')"),
    version: z.string().describe("Product version (e.g. '9.4', '4.16')"),
    severity: z.string().optional().default("4 (Low)").describe("Severity: '1 (Urgent)', '2 (High)', '3 (Normal)', '4 (Low)'"),
    accountNumber: z.string().describe("Red Hat account number"),
    cep: z.boolean().optional().default(false).describe("Consultant Engaged — set true if a consultant is working the case"),
    contactName: z.string().optional().describe("Primary contact name for the case"),
  },
  async ({ summary, description, product, version, severity, accountNumber, cep, contactName }) => {
    const body = { summary, description, product, version, severity, accountNumber, cep };
    if (contactName) body.contactName = contactName;
    const result = await apiRequest("/cases", {
      method: "POST",
      body: JSON.stringify(body),
    });
    // Response is { location: [".../<caseNumber>"] } — extract and fetch full case
    const loc = result?.location?.[0] || "";
    const newCaseNumber = loc.split("/").pop();
    if (newCaseNumber) {
      const data = await apiRequest(`/cases/${newCaseNumber}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "updateCase",
  "Update fields on an existing Red Hat support case",
  {
    caseNumber: z.string().describe("The case number"),
    severity: z.string().optional().describe("Severity: '1 (Urgent)', '2 (High)', '3 (Normal)', '4 (Low)'"),
    status: z.string().optional().describe("Case status (e.g. 'Waiting on Red Hat', 'Waiting on Customer')"),
    cep: z.boolean().optional().describe("Consultant Engaged flag"),
    contactName: z.string().optional().describe("Primary contact name"),
    alternateId: z.string().optional().describe("Alternate contact/tracking reference"),
    summary: z.string().optional().describe("Update the case summary"),
    description: z.string().optional().describe("Update the case description"),
  },
  async ({ caseNumber, ...fields }) => {
    const body = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) body[k] = v;
    }
    if (Object.keys(body).length === 0) {
      return { content: [{ type: "text", text: "No fields to update" }] };
    }
    await apiRequest(`/cases/${caseNumber}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    // Fetch updated case to confirm
    const data = await apiRequest(`/cases/${caseNumber}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool(
  "closeCase",
  "Close a Red Hat support case",
  {
    caseNumber: z.string().describe("The case number"),
    closureComment: z.string().optional().describe("Optional closing comment/resolution summary"),
  },
  async ({ caseNumber, closureComment }) => {
    if (closureComment) {
      await apiRequest(`/cases/${caseNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ commentBody: closureComment, isPublic: true }),
      });
    }
    await apiRequest(`/cases/${caseNumber}`, {
      method: "PUT",
      body: JSON.stringify({ status: "Closed" }),
    });
    const data = await apiRequest(`/cases/${caseNumber}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
