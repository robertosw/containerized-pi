// pi extension: Dart LSP navigation + warm diagnostics.
// Six tools, two result hooks (write/edit -> daemon sync; bash -> tip),
// one prompt hook (prefer specific tools over bash).
// Lazy: no daemon until the first tool call. Deletes daemon logs older than
// 7 days at startup.
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DartLspClient } from "../client/client.mjs";

const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new DartLspClient({ extRoot });

const workspace = () => process.cwd();

const symbolFileLine = {
  file: Type.Optional(
    Type.String({
      description:
        "Repo-relative, absolute, or unique-suffix path narrowing where to look.",
    })
  ),
  line: Type.Optional(
    Type.Integer({
      description: "1-based line hint; if the symbol is not on that line the whole file is searched.",
    })
  ),
};

function textTool(
  name: string,
  description: string,
  params: Record<string, unknown>,
  promptSnippet: string,
  fn: (p: any) => Promise<string>,
  promptGuidelines?: string[]
) {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object(params),
    promptSnippet,
    promptGuidelines,
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal,
      _onUpdate?: (u: unknown) => void,
      _ctx?: unknown
    ) {
      try {
        const text = await fn(params);
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `error: ${e?.message ?? e}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

export default function (pi: ExtensionAPI) {
  try {
    client.cleanupLogs(workspace());
  } catch {}

  pi.registerTool(
    textTool(
      "dart_references",
      "All use sites of a Dart symbol (calls, field read/write, pattern matches, event-bus dispatch/listen pairs), grouped by file, sorted. Current on-disk state, no staleness decisions needed.",
      {
        symbol: Type.String({ description: "Exact symbol name." }),
        ...symbolFileLine,
        includeExternal: Type.Optional(
          Type.Boolean({ description: "Also show references outside the workspace (pub cache, SDK). Default false." })
        ),
      },
      "All use sites of a Dart symbol (calls, field access, dispatch/listen pairs), grouped by file",
      (p) => client.call(workspace(), "references", p).then((m: any) => m.result as string),
      [
        "Finding all files/lines where a Dart symbol appears — uses, calls, reads, dispatches, references — → dart_references, never rg/grep/find.",
        "dart_references always reflects on-disk state; no freshness decisions needed.",
      ]
    )
  );

  pi.registerTool(
    textTool(
      "dart_definition",
      "Doc comment + declaration of a Dart symbol. Declarations above ~80 lines render as header + member signatures.",
      {
        symbol: Type.String({ description: "Exact symbol name." }),
        ...symbolFileLine,
      },
      "Doc comment + declaration of a Dart symbol (large classes: header + member signatures)",
      (p) => client.call(workspace(), "definition", p).then((m: any) => m.result as string),
      ["What is X / where is X declared / X's doc comment → dart_definition."]
    )
  );

  pi.registerTool(
    textTool(
      "dart_outline",
      "documentSymbol tree of a Dart file: signatures + up to 3 doc-comment lines per node, no bodies.",
      {
        file: Type.String({
          description: "Repo-relative, absolute, or unique-suffix path.",
        }),
      },
      "Symbol tree of a Dart file: signatures + doc lines, no bodies",
      (p) => client.call(workspace(), "outline", p).then((m: any) => m.result as string),
      ["What is in Dart file X / list X's members → dart_outline."]
    )
  );

  pi.registerTool(
    textTool(
      "dart_hierarchy",
      "For a type: full supertype chain + subtype tree (depth, sealed = complete) + its references (exhaustive-switch blast radius). For a member: super override chain, all overriding members, its references.",
      {
        symbol: Type.String({ description: "Exact symbol name (type or member)." }),
        ...symbolFileLine,
        depth: Type.Optional(
          Type.Integer({ description: "Subtree depth for non-sealed types. Default 2." })
        ),
        includeExternal: Type.Optional(
          Type.Boolean({ description: "Also show subtypes outside the workspace. Default false." })
        ),
      },
      "Supertypes + subtypes (sealed = complete) + references; for members: overrides/overridden-by/references",
      (p) => client.call(workspace(), "hierarchy", p).then((m: any) => m.result as string),
      [
        "What extends / implements / subtypes X, or what a member overrides and what overrides it → dart_hierarchy.",
      ]
    )
  );

  pi.registerTool(
    textTool(
      "dart_diagnose",
      "Dart errors + warnings (like flutter analyze) for the given files, or for the whole workspace when omitted. Always current.",
      {
        files: Type.Optional(
          Type.Array(Type.String(), {
            description: "Files to check; omit for the whole workspace.",
          })
        ),
        includeInfos: Type.Optional(
          Type.Boolean({ description: "Also include infos/hints. Default false." })
        ),
      },
      "Dart errors + warnings like flutter analyze (files arg, or whole workspace)",
      (p) => client.call(workspace(), "diagnose", p).then((m: any) => m.result as string),
      [
        "Any Dart errors or warnings while editing (replaces flutter analyze) → dart_diagnose.",
        "Do not run flutter analyze in bash while editing Dart; dart_diagnose is always current.",
      ]
    )
  );

  pi.registerTool(
    textTool(
      "dart_fix",
      "Quick fixes for the diagnostics on a line. Without pick: numbered list. With pick: the edit as oldText/newText hunks (whole lines, widened until unique). Never auto-applied — apply it with the edit tool.",
      {
        file: Type.String({ description: "Repo-relative, absolute, or unique-suffix path." }),
        line: Type.Integer({ description: "1-based line with the diagnostic." }),
        symbol: Type.Optional(
          Type.String({ description: "Symbol on the line (narrows the fix position)." })
        ),
        pick: Type.Optional(Type.Integer({ description: "1-based index from the list." })),
      },
      "Quick fixes for a diagnostic line; pick: n returns oldText/newText hunks to apply with edit",
      (p) => client.call(workspace(), "fix", p).then((m: any) => m.result as string),
      ["How to fix the Dart diagnostic on line N → dart_fix, then apply the returned hunks with edit."]
    )
  );

  // Write/edit hook: push the path to the daemon so analysis starts early
  // (optimization only; the per-query gate is the guarantee).
  pi.on("tool_result", async (event) => {
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const p = (event.input as any)?.path;
      if (typeof p === "string" && p.endsWith(".dart")) {
        const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
        client.sync(process.cwd(), abs);
      }
    }
  });

  // Bash tip hook: a text/file search that hit Dart code gets one nudge line.
  pi.on("tool_result", async (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = (event.input as any)?.command as string | undefined;
    if (typeof command !== "string") return;
    const text = (event.content ?? [])
      .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
      .join("\n");
    if (!text.includes(".dart")) return;
    const isSearch = /\b(grep|egrep|rg|ripgrep|ag|ack|find|ls|tree)\b/.test(command);
    if (!isSearch) return;
    const hasIdentifier = /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(command);
    if (!hasIdentifier) return;
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: "tip: that search hit Dart code — dart_references / dart_definition / dart_outline give symbol-exact results.",
        },
      ],
    };
  });

  // Counter the built-in "Use bash for file operations like ls, rg, find" rule,
  // which is listed before the dart_* guidelines.
  pi.on("before_agent_start", async (event) => {
    const rule =
      "If available, use the more specific tool for the job rather than relying on bash commands. Specific tools are often faster and provide cleaner results.";
    const guidelines = event.systemPromptOptions.promptGuidelines;
    if (!guidelines.includes(rule)) guidelines.push(rule);
  });

  pi.on("session_shutdown", async () => {
    client.dispose();
  });
}
