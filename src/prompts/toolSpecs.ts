import type { ToolSpec } from "../llm";

// Tool descriptions and specs live here, separate from the execution code in
// logseqTools.ts: they are prompt text for the model, not logic. Keep every
// description tight — specs are re-sent with every request and directly
// reduce the context left for history.

export function getLogseqToolSpecs(): ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "search_graph",
        description:
          "Search the user's Logseq graph: matching page names and block contents with uuids (cite blocks as ((uuid))). Use 1-3 short keywords, not sentences; if nothing is found, try different keywords. Task statuses (TODO/DOING/NOW) are markers — use search_tasks for those.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Case-insensitive substring to search in page names and block contents",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_tasks",
        description:
          "List task blocks by status marker (TODO, DOING, NOW, LATER, WAITING, DONE). The status is a marker on the block, not text — search_graph cannot find tasks by status. Returns uuid, status, content and page.",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              description:
                'Optional comma-separated statuses, e.g. "TODO, NOW". Default: TODO, DOING, NOW, LATER, WAITING',
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_page",
        description:
          "Read a page: metadata plus its blocks (uuid, content, depth, parentUuid) in document order, up to 200 per call. Without page — the page the user currently has open. Blocks nest under the block whose uuid matches their parentUuid; when totalBlocks is present, repeat with a bigger offset to read the rest.",
        parameters: {
          type: "object",
          properties: {
            page: {
              type: "string",
              description:
                "Page name; omit for the page open in the main editor",
            },
            offset: {
              type: "number",
              description:
                "Skip the first N blocks (document order), for reading large pages in portions",
            },
            meta_only: {
              type: "boolean",
              description:
                "true to return only page metadata (name, uuid, updatedAt) without blocks",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_block",
        description:
          "Read a block by uuid with its direct children (childBlocks with depth and parentUuid) — use it for ((uuid)) references. outline=true returns the whole subtree as an indented outline with blockRefs (same line order maps to uuids) to read an entire section at once.",
        parameters: {
          type: "object",
          properties: {
            uuid: { type: "string", description: "Block uuid" },
            outline: {
              type: "boolean",
              description:
                "true to return the entire subtree as an indented outline instead of a block with childBlocks",
            },
          },
          required: ["uuid"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_selected_blocks",
        description:
          'Get the blocks the user currently has selected in the editor. Use it when the user refers to "this" or "the selected" content.',
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "query_blocks",
        description:
          'Run a read-only query against the graph. lang="dsl" (default) uses Logseq\'s built-in {{query}} syntax, e.g. `(and (task TODO) [[project-x]])` or `(property status active)`. lang="datalog" runs a raw Datascript query over :block/* attributes. Prefer dsl.',
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "A DSL expression or a Datalog vector like [:find ?b :where ...]",
            },
            lang: {
              type: "string",
              enum: ["dsl", "datalog"],
              description: "Query language, default: dsl",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_journal",
        description:
          "Read blocks from the daily journal pages for the last N days (default 7, max 90). Returns uuid, content, page and the journal day number.",
        parameters: {
          type: "object",
          properties: {
            days: {
              type: "number",
              description: "How many last days to include, default: 7",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_recent_pages",
        description:
          "List recently updated page names (newest first) with update timestamps.",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Max page names to return, default: 10",
            },
          },
        },
      },
    },
  ];
}

// Compact read-only toolset for the "lite" preset: enough to search and read
// the graph, without the tools that small models rarely choose correctly.
const LITE_TOOL_NAMES = new Set([
  "search_graph",
  "search_tasks",
  "get_page",
  "get_block",
]);

export function getLiteToolSpecs(): ToolSpec[] {
  return getLogseqToolSpecs().filter((spec) =>
    LITE_TOOL_NAMES.has(spec.function.name)
  );
}

const WRITE_TOOL_PAGE_NOTE = "Only affects the page open in the main editor.";

export function getWriteToolSpecs(): ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "create_page",
        description:
          "Create a new page in the graph; an existing page with the same name is reused. requested=true ONLY when the user explicitly asked for this page in the current request; requested=false when you propose it yourself — the user confirms in the UI, and if they decline, do not retry.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Name of the new page" },
            first_block: {
              type: "string",
              description:
                "Optional content of a SINGLE flat first block. Do not combine with outline.",
            },
            outline: {
              type: "string",
              description:
                "Optional structured initial content as an indented list ('- Section\\n  - item'): top-level items and one child level become real blocks, deeper items flatten to • lines. Use only when the user asked for a structured page.",
            },
            requested: {
              type: "boolean",
              description:
                "true when the user explicitly asked for this page; false when you propose it (the user then confirms)",
            },
          },
          required: ["title", "requested"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "append_journal",
        description:
          "Append a single flat block to a journal page by date WITHOUT needing that page open — use for notes like \"add to today's journal\" from any page.",
        parameters: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description:
                "Journal day: today (default), yesterday, tomorrow or YYYY-MM-DD",
            },
            content: {
              type: "string",
              description:
                "Single block content (Markdown); lists become • bullets, headings stripped.",
            },
          },
          required: ["content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "insert_block",
        description: `Append one flat block to the end of the currently open page, or right after after_uuid. Lists inside content become • bullets; for real child blocks use insert_outline. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "Single block content (Markdown); lists become • bullets, headings stripped. One block per call.",
            },
            after_uuid: {
              type: "string",
              description:
                "Optional block uuid: insert right after this block instead of the page end",
            },
          },
          required: ["content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "insert_outline",
        description: `Insert a structured outline as real nested blocks on the currently open page: top-level items and one child level become blocks, deeper items flatten to • lines. Only for structured outlines; for a simple list use insert_block. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            outline: {
              type: "string",
              description:
                "Outline, one item per line, e.g. '- Section\\n  - item'. Markers -, *, +, 1., 1); indent with 2 spaces or a tab.",
            },
            after_uuid: {
              type: "string",
              description:
                "Optional block uuid: insert the outline after this block as siblings",
            },
            parent_uuid: {
              type: "string",
              description:
                "Optional block uuid: insert as children of this block. Do not combine with after_uuid.",
            },
          },
          required: ["outline"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "prepend_block",
        description: `Insert one flat block at the top of the currently open page. Lists become • bullets; for real child blocks use insert_outline. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "Single block content (Markdown); lists become • bullets, headings stripped.",
            },
          },
          required: ["content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_block",
        description: `Replace the content of one block on the currently open page. Get the uuid from get_page or search_graph first. Lists become • bullets; no child blocks are created. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            uuid: { type: "string", description: "Block uuid" },
            content: {
              type: "string",
              description:
                "New single-block content (Markdown); lists become • bullets, headings stripped. Replaces the old content entirely.",
            },
          },
          required: ["uuid", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "remove_block",
        description: `Remove a block (and its children) from the currently open page. Only use when the user clearly asked to delete it. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            uuid: { type: "string", description: "Block uuid" },
          },
          required: ["uuid"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "move_block",
        description: `Move a block within the currently open page: before/after a target block, or as its last child. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            uuid: { type: "string", description: "Block uuid to move" },
            target_uuid: {
              type: "string",
              description: "Target block uuid",
            },
            before: {
              type: "boolean",
              description: "Place before the target (default: after)",
            },
            as_child: {
              type: "boolean",
              description: "Place as the last child of the target",
            },
          },
          required: ["uuid", "target_uuid"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "upsert_block_property",
        description: `Set or replace a property (key:: value) on a block of the currently open page. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            uuid: { type: "string", description: "Block uuid" },
            key: { type: "string", description: "Property key" },
            value: { type: "string", description: "Property value" },
          },
          required: ["uuid", "key", "value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_drawing",
        description:
          "Create an Excalidraw drawing embedded into the currently open page as [[draws/<name>.excalidraw]] — an inline editable canvas. For sketches, flowcharts, mind maps. Origin top-left, y grows down, units px; spread shapes out and add text labels. Pass shapes: [] for an empty canvas.",
        parameters: {
          type: "object",
          properties: {
            shapes: {
              type: "array",
              description:
                "Each shape: {type: rectangle|ellipse|text|arrow, x, y, text?, width?, height?, color?, background?}. text shapes need text (may contain \\n); arrows go from (x,y) to (x2,y2) and need x2,y2. Defaults: rectangle 160x80 at (100,100), ellipse 160x90, color #1e1e1e, background transparent.",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    description: "rectangle | ellipse | text | arrow",
                  },
                  text: { type: "string", description: "Text content (text shapes)" },
                  x: { type: "number", description: "Left coordinate, px" },
                  y: { type: "number", description: "Top coordinate, px" },
                  x2: { type: "number", description: "Arrow end x, px" },
                  y2: { type: "number", description: "Arrow end y, px" },
                  width: { type: "number", description: "Width, px" },
                  height: { type: "number", description: "Height, px" },
                  color: {
                    type: "string",
                    description: "Stroke color, e.g. #e03131",
                  },
                  background: {
                    type: "string",
                    description: "Fill color, e.g. #ffd43b or transparent",
                  },
                },
              },
            },
          },
          required: ["shapes"],
        },
      },
    },
  ];
}

// Skills are advertised in the system prompt as a catalog; this tool loads
// the full instructions of one skill on the model's request.
export function getSkillToolSpecs(): ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "use_skill",
        description:
          "Load the full instructions of a skill from the Available skills catalog. Call it before answering when the request clearly matches one of the listed skills; not for unrelated requests.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Skill name from the catalog",
            },
          },
          required: ["name"],
        },
      },
    },
  ];
}
