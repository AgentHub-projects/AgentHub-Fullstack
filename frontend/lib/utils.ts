export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

export function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

const EXT_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", css: "css", html: "html", htm: "html",
  yml: "yaml", yaml: "yaml",
  md: "markdown", mdx: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift",
  sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  xml: "xml", svg: "xml",
  toml: "toml", ini: "ini", cfg: "ini",
  dockerfile: "dockerfile",
};

export function languageFromPath(path: string) {
  const fileName = path.split("/").filter(Boolean).at(-1) ?? path;
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : "";
  if (!ext) return "text";
  if (fileName.toLowerCase() === "dockerfile") return "dockerfile";
  return EXT_MAP[ext] ?? ext;
}
