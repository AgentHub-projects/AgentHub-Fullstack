import { Injectable } from "@nestjs/common";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDto, AgentEvent, AgentEventType, AgentRun } from "@agenthub/shared";
import type { PreparedWorktree } from "./worktree.service";

export interface RunnerContext {
  run: AgentRun;
  agent: AgentDto;
  prompt: string;
  worktree: PreparedWorktree;
  emit: (event: Omit<AgentEvent, "eventId" | "seq" | "ts">) => void;
}

export interface RunnerResult {
  output: string;
  summary: string;
}

const AGENT_COMMAND_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ComSpec",
  "PSModulePath",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_GIT_BASH_PATH"
] as const;

export function buildAgentCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AGENT_COMMAND_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export function buildAgentPrompt(agent: AgentDto, task: string): string {
  if (agent.systemPrompt) {
    return [
      agent.systemPrompt,
      "",
      "Task:",
      task
    ].join("\n");
  }

  // Fallback for agents without a systemPrompt
  return [
    "You are an AgentHub coding agent. Only modify files within the current working directory (isolated git worktree).",
    "Do NOT modify files outside this directory.",
    "",
    "User request:",
    task,
    "",
    "Complete the task and ensure all output files are ready to commit."
  ].join("\n");
}

// ---- Claude stream-json event types ----

interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface ClaudeAssistantMessage {
  content?: ClaudeContentBlock[];
}

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: ClaudeAssistantMessage;
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
}

interface ParsedClaudeEvent {
  agentEventType: AgentEventType;
  payload: unknown;
  text?: string;
}

export function parseClaudeStreamLine(line: string): ParsedClaudeEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: ClaudeStreamEvent;
  try {
    parsed = JSON.parse(trimmed) as ClaudeStreamEvent;
  } catch {
    // Non-JSON line, emit as text
    return {
      agentEventType: "text_delta",
      payload: { text: trimmed },
      text: trimmed
    };
  }

  // system events (init, etc.)
  if (parsed.type === "system") {
    return {
      agentEventType: "agent_thinking",
      payload: {
        mode: "system",
        subtype: parsed.subtype,
        sessionId: parsed.session_id
      }
    };
  }

  // result event (completion)
  if (parsed.type === "result") {
    const text = typeof parsed.result === "string" ? parsed.result : "";
    return {
      agentEventType: parsed.is_error ? "agent_failed" : "agent_completed",
      payload: {
        result: text,
        isError: parsed.is_error,
        durationMs: parsed.duration_ms,
        numTurns: parsed.num_turns,
        totalCostUsd: parsed.total_cost_usd
      },
      text
    };
  }

  // user events (usually contain tool_result blocks)
  if (parsed.type === "user") {
    const toolResultBlocks = parsed.message?.content?.filter(
      (c) => c.type === "tool_result"
    ) ?? [];
    if (toolResultBlocks.length > 0) {
      const firstResult = toolResultBlocks[0];
      const resultText = typeof firstResult.content === "string"
        ? firstResult.content
        : JSON.stringify(firstResult.content);
      return {
        agentEventType: "tool_result",
        payload: {
          toolUseId: firstResult.tool_use_id,
          content: resultText
        },
        text: resultText
      };
    }
    // user events without tool results - emit as agent_thinking
    return {
      agentEventType: "agent_thinking",
      payload: { type: "user", content: parsed.message }
    };
  }

  // assistant events - iterate content blocks
  if (parsed.type === "assistant") {
    const blocks = parsed.message?.content ?? [];
    if (blocks.length === 0) {
      return undefined;
    }

    // Only handle the first content block per line (each block comes on its own line in practice)
    const block = blocks[0];

    if (block.type === "thinking" && typeof block.thinking === "string") {
      return {
        agentEventType: "agent_thinking",
        payload: { thinking: block.thinking },
        text: block.thinking
      };
    }

    if (block.type === "text" && typeof block.text === "string") {
      return {
        agentEventType: "text_delta",
        payload: { text: block.text },
        text: block.text
      };
    }

    if (block.type === "tool_use") {
      const toolName = block.name ?? "unknown";
      return {
        agentEventType: "tool_use",
        payload: {
          toolName,
          toolInput: block.input
        },
        text: `[Tool: ${toolName}]`
      };
    }

    // Fallback for other content block types
    return {
      agentEventType: "agent_thinking",
      payload: { type: block.type, block }
    };
  }

  return undefined;
}

@Injectable()
export class AgentRunner {
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();

  async run(context: RunnerContext): Promise<RunnerResult> {
    if (process.env.MOCK_AGENT === "true") {
      return this.runMock(context);
    }
    return this.runClaude(context);
  }

  cancel(runId: string): boolean {
    const child = this.children.get(runId);
    if (!child) {
      return false;
    }
    child.kill("SIGTERM");
    this.children.delete(runId);
    return true;
  }

  private async runMock(context: RunnerContext): Promise<RunnerResult> {
    context.emit({
      type: "agent_thinking",
      runId: context.run.id,
      conversationId: context.run.conversationId,
      agentId: context.run.agentId,
      payload: { mode: "mock", mock: true }
    });

    let output: string;

    // Agent-aware mock output
    if (context.agent.role === "orchestrator") {
      output = this.mockOrchestrator(context);
    } else if (context.agent.role === "backend-developer") {
      output = await this.mockBackendWorker(context);
    } else if (context.agent.role === "frontend-developer") {
      output = await this.mockFrontendWorker(context);
    } else if (context.agent.role === "qa-engineer") {
      output = this.mockTestWorker(context);
    } else if (context.agent.role === "code-reviewer") {
      output = this.mockReviewWorker(context);
    } else {
      // Generic mock: generate todo files (keep async for worktree sync tests)
      const wrappedPrompt = buildAgentPrompt(context.agent, context.prompt);
      const backendDir = join(context.worktree.worktreePath, "backend", "src", "generated");
      const frontendDir = join(context.worktree.worktreePath, "frontend", "src", "generated");
      await mkdir(backendDir, { recursive: true });
      await mkdir(frontendDir, { recursive: true });
      await writeFile(
        join(backendDir, "todo-service.ts"),
        [
          "export interface TodoItem {",
          "  id: string;",
          "  title: string;",
          "  done: boolean;",
          "}",
          "",
          "export function createTodo(title: string): TodoItem {",
          "  return { id: crypto.randomUUID(), title, done: false };",
          "}",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        join(frontendDir, "TodoList.tsx"),
        [
          "export function TodoList() {",
          "  return <section><h2>Mock Todo List</h2><p>Generated by AgentHub MOCK_AGENT.</p></section>;",
          "}",
          ""
        ].join("\n"),
        "utf8"
      );
      output = `MOCK_AGENT=true mock run generated todo examples. Wrapped prompt:\n${wrappedPrompt}`;
    }

    const summary = `# AgentHub Run ${context.run.id}\n\n${output}\n`;
    await writeFile(context.worktree.logPath, `${output}\n`, "utf8");
    context.emit({
      type: "text_delta",
      runId: context.run.id,
      conversationId: context.run.conversationId,
      agentId: context.run.agentId,
      payload: { text: output }
    });

    return { output, summary };
  }

  private mockOrchestrator(context: RunnerContext): string {
    const prompt = context.prompt.toLowerCase();
    const isTodo = prompt.includes("todo") || prompt.includes("todolist") || prompt.includes("注册") || prompt.includes("登录");

    // If the prompt contains worker task results, this is a verification run
    if (prompt.includes("Worker task results:") || prompt.includes("worker task results")) {
      return [
        "I have reviewed all worker outputs. Here is my verdict:",
        "",
        "---AGENTHUB_VERDICT---",
        JSON.stringify({
          verdict: "complete",
          summary: "All tasks have been completed successfully. Backend API and frontend UI are consistent and functional.",
        }, null, 2),
        "---END_AGENTHUB_VERDICT---",
      ].join("\n");
    }

    // TodoList-specific plan
    if (isTodo) {
      return [
        "I have analyzed the TodoList request. Here is the execution plan:",
        "",
        "---AGENTHUB_PLAN---",
        JSON.stringify({
          summary: "Build a full-stack TodoList app with user auth (register/login) and todo CRUD (add, check, delete)",
          tasks: [
            {
              agentId: "backend-agent",
              task: "Create Express + TypeScript REST API with: 1) POST /api/auth/register and POST /api/auth/login for user auth (JWT), 2) GET/POST /api/todos for list and create, 3) PUT /api/todos/:id for toggle done, 4) DELETE /api/todos/:id, 5) SQLite database with users and todos tables",
              dependsOn: [],
            },
            {
              agentId: "frontend-agent",
              task: "Build React + TypeScript UI with: 1) Register and Login pages with form validation, 2) TodoList page showing todos with checkboxes and delete buttons, 3) AddTodo form, 4) Auth context with JWT token management, 5) API client for all backend endpoints",
              dependsOn: ["backend-agent"],
            },
          ],
        }, null, 2),
        "---END_AGENTHUB_PLAN---",
      ].join("\n");
    }

    // Generic plan
    return [
      "I have analyzed the request. Here is the execution plan:",
      "",
      "---AGENTHUB_PLAN---",
      JSON.stringify({
        summary: "Build the requested feature with backend API and frontend UI",
        tasks: [
          {
            agentId: "backend-agent",
            task: "Create REST API with proper endpoints, validation, and data models",
            dependsOn: [],
          },
          {
            agentId: "frontend-agent",
            task: "Build React components with API integration and proper UX",
            dependsOn: ["backend-agent"],
          },
        ],
      }, null, 2),
      "---END_AGENTHUB_PLAN---",
    ].join("\n");
  }

  private async mockBackendWorker(context: RunnerContext): Promise<string> {
    const worktreePath = context.worktree.worktreePath;
    const isTodo = context.prompt.toLowerCase().includes("todo");

    if (isTodo) {
      const backendDir = join(worktreePath, "backend", "src");
      await mkdir(backendDir, { recursive: true });

      // Generate TodoList backend files
      await writeFile(
        join(backendDir, "server.ts"),
        [
          'import express from "express";',
          'import cors from "cors";',
          'import { authRouter } from "./routes/auth";',
          'import { todoRouter } from "./routes/todos";',
          "",
          'const app = express();',
          'app.use(cors());',
          'app.use(express.json());',
          "",
          'app.use("/api/auth", authRouter);',
          'app.use("/api/todos", todoRouter);',
          "",
          'const PORT = process.env.PORT ?? 3001;',
          "app.listen(PORT, () => {",
          '  console.log(`TodoList API running on port ${PORT}`);',
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      await mkdir(join(backendDir, "routes"), { recursive: true });
      await writeFile(
        join(backendDir, "routes", "auth.ts"),
        [
          'import { Router, type Request, type Response } from "express";',
          'import bcrypt from "bcryptjs";',
          'import jwt from "jsonwebtoken";',
          "",
          'const router = Router();',
          'const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";',
          "",
          "// In-memory user store (use DB in production)",
          "const users: { id: string; username: string; password: string }[] = [];",
          "",
          "router.post('/register', async (req: Request, res: Response) => {",
          "  const { username, password } = req.body;",
          "  if (!username || !password) {",
          "    res.status(400).json({ error: 'Username and password required' }); return;",
          "  }",
          "  if (users.find(u => u.username === username)) {",
          "    res.status(409).json({ error: 'Username already exists' }); return;",
          "  }",
          "  const hashed = await bcrypt.hash(password, 10);",
          "  const user = { id: crypto.randomUUID(), username, password: hashed };",
          "  users.push(user);",
          "  const token = jwt.sign({ userId: user.id, username }, JWT_SECRET);",
          "  res.status(201).json({ token, user: { id: user.id, username } });",
          "});",
          "",
          "router.post('/login', async (req: Request, res: Response) => {",
          "  const { username, password } = req.body;",
          "  const user = users.find(u => u.username === username);",
          "  if (!user || !(await bcrypt.compare(password, user.password))) {",
          "    res.status(401).json({ error: 'Invalid credentials' }); return;",
          "  }",
          "  const token = jwt.sign({ userId: user.id, username }, JWT_SECRET);",
          "  res.json({ token, user: { id: user.id, username } });",
          "});",
          "",
          "export { router as authRouter };",
          "",
        ].join("\n"),
        "utf8",
      );

      await writeFile(
        join(backendDir, "routes", "todos.ts"),
        [
          'import { Router, type Request, type Response } from "express";',
          'import jwt from "jsonwebtoken";',
          "",
          'const router = Router();',
          'const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";',
          "",
          "interface Todo {",
          "  id: string;",
          "  userId: string;",
          "  title: string;",
          "  done: boolean;",
          "  createdAt: string;",
          "}",
          "",
          "const todos: Todo[] = [];",
          "",
          "// Auth middleware",
          "function auth(req: Request, res: Response, next: Function) {",
          "  const header = req.headers.authorization;",
          "  if (!header) { res.status(401).json({ error: 'No token' }); return; }",
          "  try {",
          "    const payload = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET) as { userId: string };",
          "    (req as any).userId = payload.userId;",
          "    next();",
          "  } catch { res.status(401).json({ error: 'Invalid token' }); return; }",
          "}",
          "",
          "router.use(auth);",
          "",
          "router.get('/', (req: Request, res: Response) => {",
          "  const userTodos = todos.filter(t => t.userId === (req as any).userId);",
          "  res.json(userTodos);",
          "});",
          "",
          "router.post('/', (req: Request, res: Response) => {",
          "  const { title } = req.body;",
          "  if (!title) { res.status(400).json({ error: 'Title required' }); return; }",
          "  const todo: Todo = {",
          "    id: crypto.randomUUID(),",
          "    userId: (req as any).userId,",
          "    title,",
          "    done: false,",
          "    createdAt: new Date().toISOString(),",
          "  };",
          "  todos.push(todo);",
          "  res.status(201).json(todo);",
          "});",
          "",
          "router.put('/:id', (req: Request, res: Response) => {",
          "  const todo = todos.find(t => t.id === req.params.id && t.userId === (req as any).userId);",
          "  if (!todo) { res.status(404).json({ error: 'Not found' }); return; }",
          "  if (req.body.done !== undefined) todo.done = req.body.done;",
          "  if (req.body.title) todo.title = req.body.title;",
          "  res.json(todo);",
          "});",
          "",
          "router.delete('/:id', (req: Request, res: Response) => {",
          "  const idx = todos.findIndex(t => t.id === req.params.id && t.userId === (req as any).userId);",
          "  if (idx === -1) { res.status(404).json({ error: 'Not found' }); return; }",
          "  todos.splice(idx, 1);",
          "  res.json({ ok: true });",
          "});",
          "",
          "export { router as todoRouter };",
          "",
        ].join("\n"),
        "utf8",
      );

      // Also write package.json for the backend
      await writeFile(
        join(worktreePath, "backend", "package.json"),
        JSON.stringify({
          name: "todolist-backend",
          scripts: { dev: "tsx src/server.ts", build: "tsc", start: "node dist/server.js" },
          dependencies: { express: "^4.18", cors: "^2.8", bcryptjs: "^2.4", jsonwebtoken: "^9.0" },
          devDependencies: { typescript: "^5.0", tsx: "^4.0", "@types/express": "^4.17", "@types/bcryptjs": "^2.4", "@types/jsonwebtoken": "^9.0" },
        }, null, 2),
        "utf8",
      );

      return [
        "TodoList Backend API created successfully.",
        "",
        "## Auth Endpoints",
        "- POST /api/auth/register — Register with username/password, returns JWT",
        "- POST /api/auth/login — Login with username/password, returns JWT",
        "",
        "## Todo Endpoints (JWT required)",
        "- GET /api/todos — List user's todos",
        "- POST /api/todos — Create todo (title required)",
        "- PUT /api/todos/:id — Update todo (toggle done/edit title)",
        "- DELETE /api/todos/:id — Delete todo",
        "",
        "## Implementation",
        "- Express + TypeScript",
        "- bcryptjs for password hashing",
        "- jsonwebtoken for JWT auth",
        "- In-memory storage with userId-based isolation",
      ].join("\n");
    }

    // Generic (non-Todo) mock
    const output = [
      "Backend API created successfully.",
      "",
      "## Endpoints",
      "- GET /api/items — List all items",
      "- POST /api/items — Create item",
      "- GET /api/items/:id — Get item by ID",
      "- PUT /api/items/:id — Update item",
      "- DELETE /api/items/:id — Remove item",
      "",
      "All endpoints include proper validation and error handling.",
    ].join("\n");

    return output;
  }

  private async mockFrontendWorker(context: RunnerContext): Promise<string> {
    const worktreePath = context.worktree.worktreePath;
    const isTodo = context.prompt.toLowerCase().includes("todo");

    if (isTodo) {
      const srcDir = join(worktreePath, "frontend", "src");
      await mkdir(srcDir, { recursive: true });
      await mkdir(join(srcDir, "components"), { recursive: true });
      await mkdir(join(srcDir, "contexts"), { recursive: true });

      // Auth context
      await writeFile(
        join(srcDir, "contexts", "AuthContext.tsx"),
        [
          'import { createContext, useContext, useState, useCallback, type ReactNode } from "react";',
          "",
          "interface User { id: string; username: string; }",
          "interface AuthState { user: User | null; token: string | null; }",
          "",
          "const AuthContext = createContext<{",
          "  auth: AuthState;",
          "  login: (token: string, user: User) => void;",
          "  logout: () => void;",
          '  isAuthenticated: boolean;',
          "} | null>(null);",
          "",
          "export function AuthProvider({ children }: { children: ReactNode }) {",
          "  const [auth, setAuth] = useState<AuthState>(() => {",
          "    try {",
          "      const saved = localStorage.getItem('todolist-auth');",
          "      return saved ? JSON.parse(saved) : { user: null, token: null };",
          "    } catch { return { user: null, token: null }; }",
          "  });",
          "",
          "  const login = useCallback((token: string, user: User) => {",
          "    const state = { token, user };",
          '    localStorage.setItem("todolist-auth", JSON.stringify(state));',
          "    setAuth(state);",
          "  }, []);",
          "",
          "  const logout = useCallback(() => {",
          '    localStorage.removeItem("todolist-auth");',
          "    setAuth({ user: null, token: null });",
          "  }, []);",
          "",
          "  return (",
          '    <AuthContext.Provider value={{ auth, login, logout, isAuthenticated: !!auth.token }}>',
          "      {children}",
          "    </AuthContext.Provider>",
          "  );",
          "}",
          "",
          "export function useAuth() {",
          "  const ctx = useContext(AuthContext);",
          '  if (!ctx) throw new Error("useAuth must be inside AuthProvider");',
          "  return ctx;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      // API client
      await writeFile(
        join(srcDir, "api.ts"),
        [
          'const BASE = "http://localhost:3001/api";',
          "",
          "function getToken() {",
          "  try {",
          "    const saved = localStorage.getItem('todolist-auth');",
          "    return saved ? JSON.parse(saved).token : null;",
          "  } catch { return null; }",
          "}",
          "",
          "async function request(path: string, options: RequestInit = {}) {",
          "  const token = getToken();",
          "  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers as Record<string, string> ?? {}) };",
          "  if (token) headers['Authorization'] = `Bearer ${token}`;",
          "  const res = await fetch(`${BASE}${path}`, { ...options, headers });",
          "  if (!res.ok) { const err = await res.json().catch(() => ({ error: 'Request failed' })); throw new Error(err.error); }",
          "  return res.json();",
          "}",
          "",
          "export const authApi = {",
          "  register: (username: string, password: string) => request('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),",
          "  login: (username: string, password: string) => request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),",
          "};",
          "",
          "export const todoApi = {",
          "  list: () => request('/todos'),",
          "  create: (title: string) => request('/todos', { method: 'POST', body: JSON.stringify({ title }) }),",
          "  update: (id: string, data: { title?: string; done?: boolean }) => request(`/todos/${id}`, { method: 'PUT', body: JSON.stringify(data) }),",
          "  remove: (id: string) => request(`/todos/${id}`, { method: 'DELETE' }),",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      // Login page
      await writeFile(
        join(srcDir, "components", "LoginPage.tsx"),
        [
          'import { useState, type FormEvent } from "react";',
          'import { useAuth } from "../contexts/AuthContext";',
          'import { authApi } from "../api";',
          "",
          "export function LoginPage({ onSwitch }: { onSwitch: () => void }) {",
          "  const { login } = useAuth();",
          "  const [username, setUsername] = useState('');",
          "  const [password, setPassword] = useState('');",
          "  const [error, setError] = useState('');",
          "",
          "  async function handleSubmit(e: FormEvent) {",
          "    e.preventDefault();",
          "    setError('');",
          "    try {",
          "      const data = await authApi.login(username, password);",
          "      login(data.token, data.user);",
          "    } catch (err: any) { setError(err.message); }",
          "  }",
          "",
          "  return (",
          '    <div style={{ maxWidth: 400, margin: "60px auto", padding: 24 }}>',
          "      <h2>Login</h2>",
          "      {error && <p style={{ color: 'red' }}>{error}</p>}",
          '      <form onSubmit={handleSubmit}>',
          '        <input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} required /><br/><br/>',
          '        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required /><br/><br/>',
          '        <button type="submit">Login</button>',
          "      </form>",
          '      <p>No account? <button onClick={onSwitch}>Register</button></p>',
          "    </div>",
          "  );",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      // Register page
      await writeFile(
        join(srcDir, "components", "RegisterPage.tsx"),
        [
          'import { useState, type FormEvent } from "react";',
          'import { useAuth } from "../contexts/AuthContext";',
          'import { authApi } from "../api";',
          "",
          "export function RegisterPage({ onSwitch }: { onSwitch: () => void }) {",
          "  const { login } = useAuth();",
          "  const [username, setUsername] = useState('');",
          "  const [password, setPassword] = useState('');",
          "  const [error, setError] = useState('');",
          "",
          "  async function handleSubmit(e: FormEvent) {",
          "    e.preventDefault();",
          "    setError('');",
          "    try {",
          "      const data = await authApi.register(username, password);",
          "      login(data.token, data.user);",
          "    } catch (err: any) { setError(err.message); }",
          "  }",
          "",
          "  return (",
          '    <div style={{ maxWidth: 400, margin: "60px auto", padding: 24 }}>',
          "      <h2>Register</h2>",
          "      {error && <p style={{ color: 'red' }}>{error}</p>}",
          '      <form onSubmit={handleSubmit}>',
          '        <input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} required /><br/><br/>',
          '        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required /><br/><br/>',
          '        <button type="submit">Register</button>',
          "      </form>",
          '      <p>Have an account? <button onClick={onSwitch}>Login</button></p>',
          "    </div>",
          "  );",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      // TodoList page
      await writeFile(
        join(srcDir, "components", "TodoPage.tsx"),
        [
          'import { useState, useEffect, type FormEvent } from "react";',
          'import { useAuth } from "../contexts/AuthContext";',
          'import { todoApi } from "../api";',
          "",
          "interface Todo { id: string; title: string; done: boolean; }",
          "",
          "export function TodoPage() {",
          "  const { auth, logout } = useAuth();",
          "  const [todos, setTodos] = useState<Todo[]>([]);",
          "  const [title, setTitle] = useState('');",
          "  const [error, setError] = useState('');",
          "",
          "  useEffect(() => { todoApi.list().then(setTodos).catch(e => setError(e.message)); }, []);",
          "",
          "  async function handleAdd(e: FormEvent) {",
          "    e.preventDefault();",
          "    if (!title.trim()) return;",
          "    try {",
          "      const todo = await todoApi.create(title);",
          "      setTodos(prev => [...prev, todo]);",
          "      setTitle('');",
          "    } catch (err: any) { setError(err.message); }",
          "  }",
          "",
          "  async function handleToggle(todo: Todo) {",
          "    try {",
          "      const updated = await todoApi.update(todo.id, { done: !todo.done });",
          "      setTodos(prev => prev.map(t => t.id === todo.id ? updated : t));",
          "    } catch (err: any) { setError(err.message); }",
          "  }",
          "",
          "  async function handleDelete(id: string) {",
          "    try {",
          "      await todoApi.remove(id);",
          "      setTodos(prev => prev.filter(t => t.id !== id));",
          "    } catch (err: any) { setError(err.message); }",
          "  }",
          "",
          "  return (",
          '    <div style={{ maxWidth: 500, margin: "40px auto", padding: 24 }}>',
          '      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>',
          "        <h2>Todo List</h2>",
          '        <span>{auth.user?.username} <button onClick={logout}>Logout</button></span>',
          "      </div>",
          "      {error && <p style={{ color: 'red' }}>{error}</p>}",
          '      <form onSubmit={handleAdd} style={{ display: "flex", gap: 8, marginBottom: 16 }}>',
          '        <input placeholder="What needs to be done?" value={title} onChange={e => setTitle(e.target.value)} style={{ flex: 1 }} />',
          '        <button type="submit">Add</button>',
          "      </form>",
          "      <ul style={{ listStyle: 'none', padding: 0 }}>",
          "        {todos.map(todo => (",
          '          <li key={todo.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid #eee" }}>',
          '            <input type="checkbox" checked={todo.done} onChange={() => handleToggle(todo)} />',
          '            <span style={{ flex: 1, textDecoration: todo.done ? "line-through" : "none", color: todo.done ? "#999" : "#333" }}>{todo.title}</span>',
          '            <button onClick={() => handleDelete(todo.id)} style={{ color: "red" }}>Delete</button>',
          "          </li>",
          "        ))}",
          "      </ul>",
          "      {todos.length === 0 && <p style={{ color: '#999', textAlign: 'center' }}>No todos yet. Add one!</p>}",
          "    </div>",
          "  );",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      // App component
      await writeFile(
        join(srcDir, "App.tsx"),
        [
          'import { useState } from "react";',
          'import { AuthProvider, useAuth } from "./contexts/AuthContext";',
          'import { LoginPage } from "./components/LoginPage";',
          'import { RegisterPage } from "./components/RegisterPage";',
          'import { TodoPage } from "./components/TodoPage";',
          "",
          "function AppContent() {",
          "  const { isAuthenticated } = useAuth();",
          '  const [showRegister, setShowRegister] = useState(false);',
          "",
          '  if (!isAuthenticated) {',
          "    return showRegister",
          '      ? <RegisterPage onSwitch={() => setShowRegister(false)} />',
          '      : <LoginPage onSwitch={() => setShowRegister(true)} />;',
          "  }",
          "",
          "  return <TodoPage />;",
          "}",
          "",
          "export default function App() {",
          "  return (",
          "    <AuthProvider>",
          "      <AppContent />",
          "    </AuthProvider>",
          "  );",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      // Package.json for frontend
      await writeFile(
        join(worktreePath, "frontend", "package.json"),
        JSON.stringify({
          name: "todolist-frontend",
          scripts: { dev: "vite", build: "tsc && vite build", preview: "vite preview" },
          dependencies: { react: "^19", "react-dom": "^19" },
          devDependencies: { typescript: "^5.0", vite: "^5.0", "@vitejs/plugin-react": "^4.0", "@types/react": "^19", "@types/react-dom": "^19" },
        }, null, 2),
        "utf8",
      );

      return [
        "TodoList Frontend UI created successfully.",
        "",
        "## Pages",
        "- LoginPage — Username/password login form with error handling",
        "- RegisterPage — Username/password registration form",
        "- TodoPage — Todo list with add/check/delete functionality",
        "",
        "## Features",
        "- AuthContext for JWT token management (persisted to localStorage)",
        "- API client with automatic token injection",
        "- Toggle todo done status with checkbox",
        "- Delete todo with confirmation",
        "- Empty state messaging",
        "- Login/Register page switching",
        "",
        "## Tech Stack",
        "- React + TypeScript",
        "- Vite dev server",
      ].join("\n");
    }

    // Generic (non-Todo) mock
    const output = [
      "Frontend UI created successfully.",
      "",
      "## Components",
      "- ItemList — Displays all items with loading/empty/error states",
      "- ItemForm — Create/edit form with validation",
      "- ItemDetail — Detail view with actions",
      "",
      "## Features",
      "- API integration with backend endpoints",
      "- Responsive design for mobile and desktop",
      "- Error handling with user-friendly messages",
      "- Loading states for all async operations",
    ].join("\n");

    return output;
  }

  private mockTestWorker(context: RunnerContext): string {
    return [
      "Tests completed successfully.",
      "",
      "## Test Results",
      "- Unit tests: 12/12 passed",
      "- Integration tests: 8/8 passed",
      "- E2E tests: 3/3 passed",
      "- Code coverage: 92%",
      "",
      "## Tested Scenarios",
      "- CRUD operations",
      "- Input validation",
      "- Error handling",
      "- Edge cases (empty, duplicate, boundary)",
    ].join("\n");
  }

  private mockReviewWorker(context: RunnerContext): string {
    return [
      "Code review completed.",
      "",
      "## Review Summary",
      "- Architecture: Clean separation of concerns",
      "- Security: Input validation present, no vulnerabilities found",
      "- Performance: No blocking operations, API responses < 100ms",
      "- Maintainability: Consistent patterns, good naming",
      "",
      "## Recommendations",
      "- Add rate limiting for production deployment",
      "- Consider pagination for list endpoints",
      "",
      "Overall: APPROVED",
    ].join("\n");
  }

  private async runClaude(context: RunnerContext): Promise<RunnerResult> {
    const wrappedPrompt = buildAgentPrompt(context.agent, context.prompt);
    const command = process.env.AGENT_COMMAND ?? "claude";
    const args = ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    const evidence = {
      mode: "claude-cli",
      command,
      cwd: context.worktree.worktreePath,
      shell: true
    };
    const evidenceLog = `Agent execution mode: ${JSON.stringify(evidence)}\n`;

    context.emit({
      type: "agent_thinking",
      runId: context.run.id,
      conversationId: context.run.conversationId,
      agentId: context.run.agentId,
      payload: evidence
    });
    await writeFile(context.worktree.logPath, evidenceLog, "utf8");

    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, args, {
          cwd: context.worktree.worktreePath,
          env: buildAgentCommandEnv(),
          shell: true
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void writeFile(context.worktree.logPath, `${evidenceLog}Spawn failed: ${message}\n`, "utf8");
        reject(new Error(`Failed to spawn agent command "${command}": ${message}`));
        return;
      }
      this.children.set(context.run.id, child);
      let output = "";
      let stderr = "";
      let settled = false;
      let lineBuffer = "";

      const processLine = (line: string) => {
        const event = parseClaudeStreamLine(line);
        if (!event) {
          return;
        }
        if (event.text) {
          output += event.text;
        }
        context.emit({
          type: event.agentEventType,
          runId: context.run.id,
          conversationId: context.run.conversationId,
          agentId: context.run.agentId,
          payload: event.payload
        });
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        lineBuffer += text;

        // Split on newlines, keeping the last partial line in the buffer
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          processLine(line);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", async (error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.children.delete(context.run.id);
        const message = error instanceof Error ? error.message : String(error);
        const failure = `Spawn failed: ${message}`;
        await writeFile(context.worktree.logPath, `${evidenceLog}${output}\n${stderr}${failure}\n`, "utf8");
        reject(new Error(`Failed to spawn agent command "${command}": ${message}`));
      });

      child.on("close", async (code) => {
        if (settled) {
          return;
        }
        settled = true;
        this.children.delete(context.run.id);

        // Process any remaining data in the buffer
        if (lineBuffer.trim()) {
          processLine(lineBuffer);
        }

        if (code !== 0) {
          const failure = stderr || `Agent command exited with code ${code}`;
          await writeFile(context.worktree.logPath, `${evidenceLog}${output}\n${stderr}Failure: ${failure}\n`, "utf8");
          reject(new Error(failure));
          return;
        }
        await writeFile(context.worktree.logPath, `${evidenceLog}${output}\n${stderr}`, "utf8");
        resolve({
          output,
          summary: `# AgentHub Run ${context.run.id}\n\n${output || "Claude completed without text output."}\n`
        });
      });

      child.stdin.end(wrappedPrompt);
    });
  }
}
