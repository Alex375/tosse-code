// Parsing + human labels for MCP tool names. The wire encodes an MCP tool as
// `mcp__<server>__<tool>` (non-alphanumeric characters of the original server/tool
// names are escaped to underscores). Pure + framework-free so it is unit-testable
// and shared by the grouped-transcript header (toolGroup), the step label (activity)
// and the step icon — the live thread and the off-thread sub-agent transcript then
// render MCP calls identically.

const MCP_PREFIX = "mcp__";

export interface McpToolName {
  /** Raw server segment from the wire, e.g. `claude_ai_TOSSE`. */
  server: string;
  /** Raw tool segment from the wire, e.g. `create_task`. */
  tool: string;
}

/**
 * Parse `mcp__<server>__<tool>` into its server + tool, or null for a non-MCP name.
 * The delimiter is the DOUBLE underscore: the server is everything up to the first
 * `__` after the prefix, the tool is the rest (kept verbatim — so a tool segment that
 * itself contains `__` survives). A single underscore inside the server is preserved.
 */
export function parseMcpToolName(name: string): McpToolName | null {
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

/**
 * Human-facing server label: the wire's underscore escaping read back as spaces.
 * `claude_ai_TOSSE` → "claude ai TOSSE", `playwright` → "playwright".
 */
export function prettyMcpServer(server: string): string {
  return server.replace(/_+/g, " ").trim();
}

/**
 * The one-line label for a single MCP step — "<server> : <tool>", e.g.
 * "claude ai TOSSE : create_task". null for a non-MCP name. The tool segment is kept
 * verbatim (its underscores read fine and disambiguate from the server's spaces).
 */
export function mcpStepLabel(name: string): string | null {
  const p = parseMcpToolName(name);
  return p ? `${prettyMcpServer(p.server)} : ${p.tool}` : null;
}
