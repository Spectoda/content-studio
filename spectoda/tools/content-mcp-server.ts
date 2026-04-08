/**
 * Content Studio MCP Server
 *
 * Provides content-specific tools for the AI agent:
 * - save_article: Create or update a markdown article via Editor API
 * - list_articles: List articles from content manifest
 * - read_article: Read article content and metadata
 * - update_status: Update workflow metadata (status, channels, tags)
 * - read_tone_guide: Read a specific tone guide for reference
 *
 * Communicates with the Content Editor API at CONTENT_EDITOR_URL (default: http://localhost:55279)
 * and reads the content manifest from CONTENT_MANIFEST_PATH.
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const EDITOR_URL = process.env.CONTENT_EDITOR_URL ?? "http://localhost:55279";
const MANIFEST_PATH = process.env.CONTENT_MANIFEST_PATH ?? "";

// --- JSON-RPC types ---

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: "save_article",
    description:
      "Create or update a markdown article. First creates the page in the sidebar tree (if new), then saves the markdown content to disk. Use this after generating or iterating on a draft.",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description:
            'Full slug path, e.g. "blog/my-article". For new articles, this is parentSlug + "/" + segment.',
        },
        parentSlug: {
          type: "string",
          description:
            'Parent category slug for new articles, e.g. "blog", "linkedin", "newsletter". Only needed for new articles.',
        },
        segment: {
          type: "string",
          description:
            "URL segment for the new article (kebab-case). Only needed for new articles.",
        },
        label: {
          type: "string",
          description: "Display label for the sidebar. Only needed for new articles.",
        },
        locale: {
          type: "string",
          description: 'Locale code: "cs" or "en". Defaults to "cs".',
          enum: ["cs", "en"],
        },
        content: {
          type: "string",
          description:
            "Full markdown content including YAML frontmatter (---\\ntitle: ...\\n---\\n\\nBody...).",
        },
        isNew: {
          type: "boolean",
          description:
            "Set to true when creating a brand new article (will call navigation/create first).",
        },
      },
      required: ["slug", "content"],
    },
  },
  {
    name: "list_articles",
    description:
      "List articles from the content inventory. Supports filtering by category, status, locale, and content type. Returns summaries with slug, title, status, and word count.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description:
            'Filter by category: "blog", "linkedin", "facebook", "instagram", "newsletter", "case-studies", "internal".',
        },
        status: {
          type: "string",
          description: 'Filter by status: "draft", "review", "approved", "published", "archived".',
        },
        locale: {
          type: "string",
          description: 'Filter by locale: "cs" or "en".',
        },
        contentType: {
          type: "string",
          description:
            'Filter by content type: "case_study", "technology_product", "education", "brand_culture", "realization".',
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
    },
  },
  {
    name: "read_article",
    description:
      "Read the full markdown content and metadata of a specific article by slug and locale.",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: 'Article slug, e.g. "blog/my-article".',
        },
        locale: {
          type: "string",
          description: 'Locale: "cs" or "en". Defaults to "cs".',
        },
      },
      required: ["slug"],
    },
  },
  {
    name: "update_status",
    description:
      "Update workflow metadata for an article — status, channels, tags, target audience, CTA. This writes to Firebase metadata, not to the markdown file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "Article slug.",
        },
        locale: {
          type: "string",
          description: 'Locale: "cs" or "en". Defaults to "cs".',
        },
        status: {
          type: "string",
          description: 'New status: "draft", "review", "approved", "published", "archived".',
        },
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Target channels list.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form tags.",
        },
        targetAudience: {
          type: "array",
          items: { type: "string" },
          description: 'Target audience segments, e.g. ["architekti", "elektroprojektanti"].',
        },
        cta: {
          type: "string",
          description: "Call-to-action URL.",
        },
      },
      required: ["slug"],
    },
  },
  {
    name: "read_tone_guide",
    description:
      "Read a specific tone guide for reference before writing content. Available guides: brand-voice, content-agent-brief, matty-voice-content, matty-voice-tasks, linkedin-patterns, newsletter-patterns.",
    inputSchema: {
      type: "object" as const,
      properties: {
        guide: {
          type: "string",
          description: "Tone guide name (without path or extension).",
          enum: [
            "brand-voice",
            "content-agent-brief",
            "matty-voice-content",
            "matty-voice-tasks",
            "linkedin-patterns",
            "newsletter-patterns",
          ],
        },
      },
      required: ["guide"],
    },
  },
  {
    name: "create_content_package",
    description:
      "Create a Content Package (tracked concept) from the current conversation. This promotes the thread into the sidebar workflow groups (Rozpracované → Připravené → Předané). Call this after generating initial drafts to track the content through the workflow.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string",
          description: "Content topic/title, e.g. 'LinkedIn post o synchronizaci světel'.",
        },
        brief: {
          type: "string",
          description: "Brief description of the content concept.",
        },
        channels: {
          type: "array",
          items: { type: "string" },
          description:
            'Target channels: "blog", "linkedin", "facebook", "instagram", "newsletter", "case-studies", "internal".',
        },
        audience: {
          type: "array",
          items: { type: "string" },
          description: 'Target audience, e.g. ["architekti", "lighting designéři"].',
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form tags for categorization.",
        },
      },
      required: ["topic", "channels"],
    },
  },
];

// --- Tool implementations ---

async function editorFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${EDITOR_URL}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
}

async function saveArticle(args: Record<string, unknown>): Promise<unknown> {
  const slug = args.slug as string;
  const content = args.content as string;
  const locale = (args.locale as string) ?? "cs";
  const isNew = args.isNew as boolean;

  // Step 1: Create navigation entry for new articles
  if (isNew) {
    const parentSlug = args.parentSlug as string;
    const segment = args.segment as string;
    const label = args.label as string;

    if (!parentSlug || !segment || !label) {
      return {
        error: "New articles require parentSlug, segment, and label parameters.",
      };
    }

    const createRes = await editorFetch("/api/navigation/create", {
      method: "POST",
      body: JSON.stringify({
        parentSlug,
        type: "page",
        label,
        segment,
      }),
    });

    if (!createRes.ok) {
      const errorText = await createRes.text();
      return {
        error: `Failed to create navigation entry: ${createRes.status} ${errorText}`,
      };
    }
  }

  // Step 2: Save the document
  const saveRes = await editorFetch("/api/document/save", {
    method: "POST",
    body: JSON.stringify({
      slug,
      locale,
      nodeType: "page",
      content,
    }),
  });

  if (!saveRes.ok) {
    const errorText = await saveRes.text();
    return {
      error: `Failed to save document: ${saveRes.status} ${errorText}`,
    };
  }

  return {
    success: true,
    slug,
    locale,
    message: `Article "${slug}" saved successfully (${locale}).`,
  };
}

async function listArticles(args: Record<string, unknown>): Promise<unknown> {
  // Try to read from manifest first (faster, no network)
  if (MANIFEST_PATH && existsSync(MANIFEST_PATH)) {
    try {
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
      let items: Array<Record<string, unknown>> = manifest.items ?? [];

      // Apply filters
      if (args.category) {
        const cat = args.category as string;
        items = items.filter((item) => {
          const slug = item.slug as string;
          return slug.startsWith(`${cat}/`);
        });
      }
      if (args.status) {
        items = items.filter((item) => item.status === args.status);
      }
      if (args.locale) {
        items = items.filter((item) => item.locale === args.locale);
      }
      if (args.contentType) {
        items = items.filter((item) => item.contentType === args.contentType);
      }

      const limit = (args.limit as number) ?? 20;
      items = items.slice(0, limit);

      return {
        count: items.length,
        items: items.map((item) => ({
          slug: item.slug,
          locale: item.locale,
          title: item.title,
          status: item.status ?? "unknown",
          contentType: item.contentType,
          wordCount: item.wordCount,
          channels: item.channels,
        })),
      };
    } catch {
      // Fall through to API
    }
  }

  // Fallback: use Editor API
  try {
    const params = new URLSearchParams();
    if (args.category) params.set("category", args.category as string);
    if (args.status) params.set("status", args.status as string);
    if (args.locale) params.set("locale", args.locale as string);
    const queryString = params.toString();
    const res = await editorFetch(`/api/metadata/list${queryString ? `?${queryString}` : ""}`);
    if (!res.ok) {
      return { error: `Failed to list articles: ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return {
      error: `Failed to list articles: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function readArticle(args: Record<string, unknown>): Promise<unknown> {
  const slug = args.slug as string;
  const locale = (args.locale as string) ?? "cs";

  try {
    // Read document content
    const docRes = await editorFetch(
      `/api/document?slug=${encodeURIComponent(slug)}&locale=${locale}`,
    );
    if (!docRes.ok) {
      return { error: `Failed to read article: ${docRes.status}` };
    }
    const doc = await docRes.json();

    // Read metadata
    let metadata = null;
    try {
      const metaRes = await editorFetch(
        `/api/metadata?slug=${encodeURIComponent(slug)}&locale=${locale}`,
      );
      if (metaRes.ok) {
        metadata = await metaRes.json();
      }
    } catch {
      // Metadata is optional
    }

    return {
      slug,
      locale,
      content: doc.content ?? doc,
      metadata,
    };
  } catch (err) {
    return {
      error: `Failed to read article: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function updateStatus(args: Record<string, unknown>): Promise<unknown> {
  const slug = args.slug as string;
  const locale = (args.locale as string) ?? "cs";

  const metadata: Record<string, unknown> = {};
  if (args.status) metadata.status = args.status;
  if (args.channels) metadata.channels = args.channels;
  if (args.tags) metadata.tags = args.tags;
  if (args.targetAudience) metadata.targetAudience = args.targetAudience;
  if (args.cta) metadata.cta = args.cta;

  if (Object.keys(metadata).length === 0) {
    return { error: "No metadata fields provided to update." };
  }

  try {
    const res = await editorFetch("/api/metadata", {
      method: "POST",
      body: JSON.stringify({ slug, locale, metadata }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return { error: `Failed to update metadata: ${res.status} ${errorText}` };
    }

    return {
      success: true,
      slug,
      locale,
      updated: Object.keys(metadata),
      message: `Metadata for "${slug}" updated: ${Object.keys(metadata).join(", ")}.`,
    };
  } catch (err) {
    return {
      error: `Failed to update metadata: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function readToneGuide(args: Record<string, unknown>): unknown {
  const guide = args.guide as string;

  // Resolve path relative to content root
  const studioRoot = import.meta.dir;
  const contentRoot = resolve(studioRoot, "../..");
  const guidePaths = [
    join(contentRoot, "app/v1/src/content/docs/cs/tone-guides", `${guide}.md`),
    join(contentRoot, "app/v1/src/content/docs/en/tone-guides", `${guide}.md`),
  ];

  for (const guidePath of guidePaths) {
    if (existsSync(guidePath)) {
      try {
        const content = readFileSync(guidePath, "utf-8");
        return {
          guide,
          path: guidePath,
          content,
        };
      } catch (err) {
        return {
          error: `Failed to read tone guide: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  return {
    error: `Tone guide "${guide}" not found. Available: brand-voice, content-agent-brief, matty-voice-content, matty-voice-tasks, linkedin-patterns, newsletter-patterns.`,
  };
}

async function createContentPackageTool(args: Record<string, unknown>): Promise<unknown> {
  const topic = args.topic as string;
  const channels = (args.channels as string[]) ?? [];
  const brief = (args.brief as string) ?? "";
  const audience = (args.audience as string[]) ?? [];
  const tags = (args.tags as string[]) ?? [];

  if (!topic) {
    return { error: "Topic is required." };
  }

  // POST to Content Editor API — the web app polls this endpoint and picks up new packages
  try {
    const res = await editorFetch("/api/content-packages", {
      method: "POST",
      body: JSON.stringify({ topic, brief, channels, audience, tags }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return { error: `Failed to create package: ${res.status} ${errorText}` };
    }

    const result = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
    return {
      success: true,
      package: result.data,
      message: `Content package "${topic}" created. Channels: ${channels.join(", ") || "none"}. It will appear in the sidebar under ROZPRACOVANÉ.`,
    };
  } catch (err) {
    return {
      error: `Failed to create package: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// --- MCP Protocol (stdio JSON-RPC) ---

function handleRequest(request: JsonRpcRequest): JsonRpcResponse {
  switch (request.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "content-studio-tools",
            version: "1.0.0",
          },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const params = request.params as {
        name: string;
        arguments?: Record<string, unknown>;
      };
      const toolName = params.name;
      const toolArgs = params.arguments ?? {};

      // Return a promise-based response — we handle async in the main loop
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: { _async: true, toolName, toolArgs },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      };
  }
}

async function handleToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case "save_article":
      return saveArticle(toolArgs);
    case "list_articles":
      return listArticles(toolArgs);
    case "read_article":
      return readArticle(toolArgs);
    case "update_status":
      return updateStatus(toolArgs);
    case "read_tone_guide":
      return readToneGuide(toolArgs);
    case "create_content_package":
      return createContentPackageTool(toolArgs);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

function sendResponse(response: JsonRpcResponse | JsonRpcNotification): void {
  const json = JSON.stringify(response);
  process.stdout.write(json + "\n");
}

// --- Main loop: read JSON-RPC from stdin ---

let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk: string) => {
  buffer += chunk;

  // Process complete lines
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (!line) continue;

    try {
      const message = JSON.parse(line) as JsonRpcRequest | JsonRpcNotification;

      // Notifications (no id) — just acknowledge
      if (!("id" in message)) {
        // Handle notifications like initialized
        continue;
      }

      const request = message as JsonRpcRequest;
      const response = handleRequest(request);

      // Check if this is an async tool call
      if (
        response.result &&
        typeof response.result === "object" &&
        "_async" in (response.result as Record<string, unknown>)
      ) {
        const { toolName, toolArgs } = response.result as {
          _async: boolean;
          toolName: string;
          toolArgs: Record<string, unknown>;
        };

        try {
          const result = await handleToolCall(toolName, toolArgs);
          sendResponse({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [
                {
                  type: "text",
                  text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
                },
              ],
            },
          });
        } catch (err) {
          sendResponse({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: err instanceof Error ? err.message : String(err),
                  }),
                },
              ],
              isError: true,
            },
          });
        }
      } else {
        sendResponse(response);
      }
    } catch {
      // Invalid JSON — skip
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
