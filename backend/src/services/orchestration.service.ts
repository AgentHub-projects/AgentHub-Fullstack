import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { DEFAULT_WORKSPACE_PATH } from "@agenthub/shared";
import type {
  AgentDto,
  AgentEvent,
  AgentRun,
  CodeDiffPreview,
  StartTeamRunRequest,
  TeamPlan,
  TeamTask,
  TeamRunDto,
  TeamTaskResult,
  TeamVerdict,
  ToolDefinition,
} from "@agenthub/shared";
import { AgentRunner } from "./agent-runner.service";
import { AgentService } from "./agent.service";
import { AgentEventsGateway } from "../realtime/agent-events.gateway";
import { ConversationService } from "./conversation.service";
import { TeamService } from "./team.service";
import { WorktreeService } from "./worktree.service";
import { ApiHttpException } from "./errors";
import { createId } from "./ids";

const MAX_REWORK_ITERATIONS = 3;

function parsePlanFromOutput(output: string): TeamPlan | null {
  const marker = "---AGENTHUB_PLAN---";
  const endMarker = "---END_AGENTHUB_PLAN---";
  const start = output.indexOf(marker);
  const end = output.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  const jsonStr = output.slice(start + marker.length, end).trim();
  try {
    return JSON.parse(jsonStr) as TeamPlan;
  } catch {
    return null;
  }
}

function parseVerdictFromOutput(output: string): TeamVerdict | null {
  const marker = "---AGENTHUB_VERDICT---";
  const endMarker = "---END_AGENTHUB_VERDICT---";
  const start = output.indexOf(marker);
  const end = output.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  const jsonStr = output.slice(start + marker.length, end).trim();
  try {
    return JSON.parse(jsonStr) as TeamVerdict;
  } catch {
    return null;
  }
}

function buildFallbackPlan(userRequest: string, workerMembers: { agentId: string; role: "worker" }[]): TeamPlan {
  const hasBackend = workerMembers.some((member) => member.agentId === "backend-agent");
  const hasFrontend = workerMembers.some((member) => member.agentId === "frontend-agent");
  const tasks: TeamPlan["tasks"] = [];

  if (hasBackend) {
    tasks.push({
      agentId: "backend-agent",
      task: [
        "基于用户需求实现后端部分。",
        "所有后端文件必须放在 backend/ 目录下，例如 backend/package.json、backend/src/index.ts。",
        "不要在仓库根目录创建或修改 package.json、tsconfig.json、src/ 等后端项目文件。",
        "如果任务是 TodoList，请提供注册、登录、JWT 或等价会话机制，以及 todo 的新增、列表、勾选状态更新、删除接口。",
        "为保证本地可运行，不要使用需要 node-gyp/Visual Studio 编译的原生依赖，例如 better-sqlite3、sqlite3、bcrypt；需要哈希时使用 bcryptjs 或 Node crypto，数据可使用内存或 JSON 文件。",
        "保持项目可运行，避免把 node_modules、dist 等运行产物作为交付重点。",
        "",
        "用户需求：",
        userRequest,
      ].join("\n"),
      dependsOn: [],
    });
  }

  if (hasFrontend) {
    tasks.push({
      agentId: "frontend-agent",
      task: [
        "基于用户需求实现前端部分，并接入后端接口。",
        "所有前端文件必须放在 frontend/ 目录下，例如 frontend/package.json、frontend/src/main.tsx。",
        "不要在仓库根目录创建或修改 package.json、tsconfig.json、src/ 等前端项目文件。",
        "如果任务是 TodoList，请提供注册/登录页面、todo 输入、todo 列表、勾选完成、删除操作与基本错误状态。",
        "保持项目可运行，避免把 node_modules、dist 等运行产物作为交付重点。",
        "",
        "用户需求：",
        userRequest,
      ].join("\n"),
      dependsOn: hasBackend ? ["backend-agent"] : [],
    });
  }

  for (const member of workerMembers) {
    if (tasks.some((task) => task.agentId === member.agentId)) continue;
    tasks.push({
      agentId: member.agentId,
      task: `处理用户需求中适合 ${member.agentId} 的部分，并返回可验证结果。\n\n用户需求：\n${userRequest}`,
      dependsOn: tasks.length > 0 ? [tasks[tasks.length - 1]!.agentId] : [],
    });
  }

  return {
    summary: "按默认全栈链路拆解任务：后端先提供 API，前端随后接入并完成交互。",
    tasks,
  };
}

function normalizeBackendTaskForLocalExecution(taskText: string, userRequest: string): string {
  if (!/todo|todolist|待办/i.test(userRequest)) {
    return taskText;
  }

  let normalized = taskText
    .replace(/\bSQLite database via better-sqlite3\b/gi, "in-memory data store")
    .replace(/\bSQLite database\b/gi, "in-memory data store")
    .replace(/\bbetter-sqlite3\b/gi, "in-memory store")
    .replace(/\bsqlite3\b/gi, "in-memory store")
    .replace(/\bbcrypt\b(?!js)/gi, "bcryptjs");

  if (!/node-gyp|Visual Studio|原生依赖|better-sqlite3|sqlite3/i.test(normalized)) {
    normalized = [
      normalized,
      "",
      "本地运行约束：这是验收用的简单 TodoList，不要引入需要 node-gyp/Visual Studio 编译的原生依赖；不要使用 better-sqlite3、sqlite3、bcrypt。需要密码哈希时使用 bcryptjs 或 Node crypto；数据存储使用内存 Map/数组或纯 JS JSON 文件即可。",
    ].join("\n");
  }

  return normalized;
}

function normalizePlan(plan: TeamPlan, workerMembers: { agentId: string; role: "worker" }[], userRequest: string): TeamPlan {
  const workerIds = new Set(workerMembers.map((member) => member.agentId));
  const filtered = plan.tasks.filter((task) => workerIds.has(task.agentId));
  const taskIds = new Set(filtered.map((task) => task.agentId));
  const requiresAuth =
    /注册|登录|register|login|auth/i.test(userRequest)
    && taskIds.has("backend-agent")
    && taskIds.has("frontend-agent");
  const normalizedTasks = filtered.map((task) => {
    let taskText = task.task;
    if (task.agentId === "backend-agent" && !/backend\//i.test(taskText)) {
      taskText = [
        taskText,
        "",
        "目录约束：所有后端工程文件必须写入 backend/ 目录；不要在仓库根目录创建 package.json、tsconfig.json、src/ 等后端文件。",
      ].join("\n");
    }
    if (task.agentId === "backend-agent") {
      taskText = normalizeBackendTaskForLocalExecution(taskText, userRequest);
    }
    if (task.agentId === "frontend-agent" && !/frontend\//i.test(taskText)) {
      taskText = [
        taskText,
        "",
        "目录约束：所有前端工程文件必须写入 frontend/ 目录；不要在仓库根目录创建 package.json、tsconfig.json、src/ 等前端文件。",
      ].join("\n");
    }
    if (requiresAuth && task.agentId === "backend-agent" && !/注册|登录|register|login|auth/i.test(taskText)) {
      taskText = [
        taskText,
        "",
        "补充验收要求：必须实现简单注册/登录能力，并让 todo 数据按登录用户隔离。",
      ].join("\n");
    }
    if (requiresAuth && task.agentId === "frontend-agent" && !/注册|登录|register|login|auth/i.test(taskText)) {
      taskText = [
        taskText,
        "",
        "补充验收要求：必须提供注册/登录界面，并在登录后才能添加、勾选和删除 todo。",
      ].join("\n");
    }
    return {
      ...task,
      task: taskText,
      dependsOn: task.dependsOn.filter((depId) => taskIds.has(depId)),
    };
  });

  if (normalizedTasks.length > 0) {
    return {
      ...plan,
      tasks: normalizedTasks,
    };
  }

  return buildFallbackPlan(userRequest, workerMembers);
}

function cleanAgentOutput(output: string, maxChars = 1200): string {
  const cleaned = output
    .replace(/---AGENTHUB_PLAN---[\s\S]*?---END_AGENTHUB_PLAN---/g, "")
    .replace(/---AGENTHUB_VERDICT---[\s\S]*?---END_AGENTHUB_VERDICT---/g, "")
    .trim();
  const text = cleaned || output.trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trimEnd()}\n\n...`;
}

function buildFinalSummary(workerCount: number, taskResults: TeamTaskResult[], verdict?: TeamVerdict): string {
  const completed = taskResults.filter((result) => result.status === "succeeded").length;
  const failed = taskResults.length - completed;
  const stackSummary = taskResults
    .map((result) => `- ${result.agentId}: ${cleanAgentOutput(result.output, 220).replace(/\n+/g, " ")}`)
    .join("\n");
  const headline =
    failed > 0 || verdict?.verdict === "rework"
      ? `平台未能完成任务。AgentHub 已运行 ${workerCount} 个 Claude Code Agent，但有 ${failed} 个任务失败。`
      : `平台成功完成了任务！AgentHub 通过 ${workerCount} 个真实 Claude Code 实例协作处理了这次需求。`;

  return [
    headline,
    "",
    "---",
    "生成结果",
    "",
    verdict?.summary ?? `${completed}/${taskResults.length} 个 Agent 已完成分配任务。`,
    "",
    stackSummary,
  ].join("\n");
}

/**
 * AgentScope-inspired: Build OpenAI-style tool definitions from worker agents.
 * Each worker agent becomes a "tool" the orchestrator can call.
 */
function buildLeaderTools(workerMembers: { agentId: string; role: string }[], agents: AgentService): ToolDefinition[] {
  return workerMembers
    .filter((m) => m.role === "worker")
    .map((m) => {
      const agent = agents.get(m.agentId);
      return {
        name: m.agentId,
        description: agent.description,
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: `The task description for ${agent.name}. Be specific about expected outputs.`,
            },
          },
          required: ["task"],
        },
      };
    });
}

function buildLeaderPlanPrompt(leader: AgentDto, userRequest: string, members: { agentId: string; role: string }[], agents: AgentService): string {
  const tools = buildLeaderTools(members, agents);
  const toolList = tools
    .map((t) => `- **${t.name}**: ${t.description}`)
    .join("\n");

  return [
    leader.systemPrompt ?? "You are an orchestration agent.",
    "",
    "You have access to the following agent tools (each is a specialized coding agent):",
    toolList,
    "",
    "User request:",
    userRequest,
    "",
    "Analyze the request and create a plan. Output your plan as JSON between ---AGENTHUB_PLAN--- and ---END_AGENTHUB_PLAN--- markers.",
    "Each task must specify an agentId matching one of the available agent tools above, a task description, and any dependencies.",
    "",
    "Example plan format:",
    "```json",
    "{",
    '  "summary": "Brief plan summary",',
    '  "tasks": [',
    '    { "agentId": "backend-agent", "task": "Create REST API...", "dependsOn": [] },',
    '    { "agentId": "frontend-agent", "task": "Build UI...", "dependsOn": ["backend-agent"] }',
    "  ]",
    "}",
    "```",
  ].join("\n");
}

function buildLeaderVerificationPrompt(
  leader: AgentDto,
  userRequest: string,
  plan: TeamPlan,
  taskResults: TeamTaskResult[],
): string {
  const resultsText = taskResults
    .map((tr) => `### ${tr.agentId} (${tr.status})\n\`\`\`\n${tr.output}\n\`\`\``)
    .join("\n\n");

  return [
    leader.systemPrompt ?? "You are an orchestration agent.",
    "",
    "Original user request:",
    userRequest,
    "",
    "The plan you created:",
    JSON.stringify(plan, null, 2),
    "",
    "Worker task results:",
    resultsText,
    "",
    "Directory acceptance requirements:",
    "- Backend implementation must live under backend/.",
    "- Frontend implementation must live under frontend/.",
    "- The repository root should not be a single overwritten backend-only or frontend-only project.",
    "",
    "Verify all work is complete and correct. Output your verdict using the ---AGENTHUB_VERDICT--- marker.",
  ].join("\n");
}

function buildWorkerPrompt(agent: AgentDto, task: string, dependencyOutputs: TeamTaskResult[]): string {
  const parts = [agent.systemPrompt ?? "You are a coding agent."];

  if (dependencyOutputs.length > 0) {
    parts.push("");
    parts.push("Context from upstream tasks:");
    for (const dep of dependencyOutputs) {
      parts.push(`### Output from ${dep.agentId}`);
      parts.push("```");
      parts.push(dep.output);
      parts.push("```");
    }
  }

  parts.push("");
  if (agent.id === "backend-agent" || agent.role === "backend-developer") {
    parts.push("Workspace constraint: create and modify backend code only under the backend/ directory. Do not create root-level package.json, tsconfig.json, or src/ for the backend project.");
    parts.push("");
  }
  if (agent.id === "frontend-agent" || agent.role === "frontend-developer") {
    parts.push("Workspace constraint: create and modify frontend code only under the frontend/ directory. Do not create root-level package.json, tsconfig.json, or src/ for the frontend project.");
    parts.push("");
  }
  parts.push("Task:");
  parts.push(task);
  parts.push("");
  parts.push("Return a concise user-facing summary of what you changed. Do not include shell command logs, tool traces, or internal reasoning.");

  return parts.join("\n");
}

@Injectable()
export class OrchestrationService {
  private readonly teamRuns = new Map<string, TeamRunDto>();
  private eventSeq = 0;

  constructor(
    @Inject(AgentRunner) private readonly runner: AgentRunner,
    @Inject(WorktreeService) private readonly worktrees: WorktreeService,
    @Inject(AgentService) private readonly agents: AgentService,
    @Inject(TeamService) private readonly teams: TeamService,
    @Inject(ConversationService) private readonly conversations: ConversationService,
    @Inject(AgentEventsGateway) private readonly gateway: AgentEventsGateway,
  ) {}

  getTeamRun(id: string): TeamRunDto {
    const run = this.teamRuns.get(id);
    if (!run) {
      throw new ApiHttpException(HttpStatus.NOT_FOUND, {
        code: "TEAM_RUN_NOT_FOUND",
        message: `Team run ${id} not found`,
      });
    }
    return run;
  }

  async startTeamRun(teamId: string, request: StartTeamRunRequest): Promise<TeamRunDto> {
    const team = this.teams.get(teamId);
    const leaderMember = this.teams.getLeaderMember(teamId);
    if (!leaderMember) {
      throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
        code: "NO_LEADER",
        message: "Team has no leader agent",
      });
    }
    const leader = this.agents.get(leaderMember.agentId);
    const workerMembers = this.teams.getWorkerMembers(teamId);

    const conversationId = request.conversationId ?? createId("conv");
    const repositoryPath = this.resolveRepositoryPath(conversationId, request.repositoryPath);
    const runId = createId("teamrun");
    const now = new Date().toISOString();

    const teamRun: TeamRunDto = {
      id: runId,
      teamId,
      conversationId,
      status: "planning",
      taskResults: [],
      leaderRunIds: [],
      workerRunIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.teamRuns.set(runId, teamRun);

    // Add user message to conversation
    try {
      this.conversations.createMessage(conversationId, { content: request.prompt });
    } catch {
      // ignore
    }

    // Start orchestration in background
    void this.executeTeamRun(teamRun, team.members, leader, workerMembers, { ...request, repositoryPath }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      teamRun.status = "failed";
      teamRun.updatedAt = new Date().toISOString();
      try {
        this.conversations.addAssistantMessage(conversationId, `团队运行失败：${message}`, leader.id);
      } catch {
        // keep emitting the failure even when the conversation is unavailable
      }
      this.emit({
        type: "public_text",
        runId: runId,
        conversationId,
        agentId: leader.id,
        teamRunId: runId,
        payload: { text: `团队运行失败：${message}`, title: "Orchestrator", variant: "error" },
      });
      this.emit({
        type: "result_card",
        runId: runId,
        conversationId,
        agentId: leader.id,
        teamRunId: runId,
        payload: {
          agentId: leader.id,
          title: "团队运行失败",
          status: "failed",
          summary: message,
        },
      });
    });

    return teamRun;
  }

  private resolveRepositoryPath(conversationId: string, fallback?: string): string {
    try {
      return this.conversations.get(conversationId).workspacePath || fallback || DEFAULT_WORKSPACE_PATH;
    } catch {
      return fallback || DEFAULT_WORKSPACE_PATH;
    }
  }

  private async executeTeamRun(
    teamRun: TeamRunDto,
    allMembers: { agentId: string; role: string }[],
    leader: AgentDto,
    workerMembers: { agentId: string; role: "worker" }[],
    request: StartTeamRunRequest,
  ): Promise<void> {
    const conversationId = teamRun.conversationId;

    // Phase 1: Leader Analysis
    this.emit({
      type: "public_text",
      runId: teamRun.id,
      conversationId,
      agentId: leader.id,
      teamRunId: teamRun.id,
      payload: { text: "我正在拆解你的需求，并为每个 Claude Code Agent 分配可执行任务。", title: "Orchestrator" },
    });

    const planPrompt = buildLeaderPlanPrompt(leader, request.prompt, allMembers, this.agents);
    const leaderWorktree = await this.worktrees.prepare(teamRun.id + "-leader", request.repositoryPath);

    const planResult = await this.runner.run({
      run: {
        id: teamRun.id + "-plan",
        agentId: leader.id,
        conversationId,
        status: "running",
        runtime: {
          agentId: leader.id,
          displayName: leader.name,
          provider: leader.provider,
          role: leader.role,
          worktreePath: leaderWorktree.worktreePath,
          branchName: leaderWorktree.branchName,
          status: "running",
        },
        prompt: planPrompt,
        teamRunId: teamRun.id,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      },
      agent: leader,
      prompt: planPrompt,
      worktree: leaderWorktree,
      emit: (event) => this.emitRunnerFailure(event, teamRun.id),
    });

    teamRun.leaderRunIds.push(teamRun.id + "-plan");

    const plan = normalizePlan(
      parsePlanFromOutput(planResult.output) ?? buildFallbackPlan(request.prompt, workerMembers),
      workerMembers,
      request.prompt,
    );
    teamRun.plan = plan;
    teamRun.status = "executing";
    teamRun.updatedAt = new Date().toISOString();

    this.emit({
      type: "plan_card",
      runId: teamRun.id,
      conversationId,
      agentId: leader.id,
      teamRunId: teamRun.id,
      payload: { plan },
    });
    this.emit({
      type: "public_text",
      runId: teamRun.id,
      conversationId,
      agentId: leader.id,
      teamRunId: teamRun.id,
      payload: {
        text: `我已完成任务拆解：${plan.summary} 接下来会按依赖顺序把 ${plan.tasks.length} 个任务分派给对应 Agent。`,
        title: "Orchestrator",
      },
    });

    // Phase 2: Worker Execution (dependency-ordered)
    const workerMap = new Map(workerMembers.map((w) => [w.agentId, w]));
    const taskResults = new Map<string, TeamTaskResult>();
    const completed = new Set<string>();
    const failed = new Set<string>();

    // Execute tasks in dependency order batches
    let remaining = [...plan.tasks];
    while (remaining.length > 0) {
      const ready: typeof plan.tasks = [];
      const notReady: typeof plan.tasks = [];
      const skipped: Array<{ task: TeamTask; failedDeps: string[] }> = [];

      for (const task of remaining) {
        const failedDeps = task.dependsOn.filter((depId) => failed.has(depId));
        if (failedDeps.length > 0) {
          skipped.push({ task, failedDeps });
          continue;
        }
        const depsSatisfied = task.dependsOn.every((depId) => completed.has(depId));
        if (depsSatisfied) {
          ready.push(task);
        } else {
          notReady.push(task);
        }
      }

      if (skipped.length > 0) {
        const skippedResults = skipped.map(({ task, failedDeps }) => {
          const output = `跳过 ${task.agentId}：依赖任务失败（${failedDeps.join(", ")}），无法安全继续执行。`;
          const skippedResult: TeamTaskResult = {
            agentId: task.agentId,
            runId: `${teamRun.id}-${task.agentId}`,
            status: "failed",
            output,
          };
          taskResults.set(task.agentId, skippedResult);
          completed.add(task.agentId);
          failed.add(task.agentId);
          this.emit({
            type: "result_card",
            runId: teamRun.id,
            conversationId,
            agentId: task.agentId,
            teamRunId: teamRun.id,
            payload: {
              agentId: task.agentId,
              title: `${task.agentId} 已跳过`,
              status: "failed",
              summary: output,
            },
          });
          try {
            this.conversations.addAssistantMessage(conversationId, output, task.agentId);
          } catch {
            // event stream remains the primary real-time channel
          }
          return skippedResult;
        });
        teamRun.taskResults = [...teamRun.taskResults, ...skippedResults];
        teamRun.updatedAt = new Date().toISOString();
      }

      if (ready.length === 0) {
        if (notReady.length === 0) {
          break;
        }
        throw new Error("Circular or unresolvable task dependencies detected");
      }

      // Execute ready tasks in parallel
      const batchResults = await Promise.all(
        ready.map(async (task) => {
          const agentId = task.agentId;
          const worker = workerMap.get(agentId);
          if (!worker) {
            return {
              agentId,
              runId: "",
              status: "failed" as const,
              output: `Agent ${agentId} is not a member of this team`,
            };
          }

          try {
            const agent = this.agents.get(agentId);
            const depResults = task.dependsOn
              .map((depId) => taskResults.get(depId))
              .filter((r): r is TeamTaskResult => r !== undefined);

            const workerPrompt = buildWorkerPrompt(agent, task.task, depResults);
            const workerWorktree = await this.worktrees.prepare(
              `${teamRun.id}-${agentId}`,
              request.repositoryPath,
            );
            const workerRunId = `${teamRun.id}-${agentId}`;
            if (!teamRun.workerRunIds.includes(workerRunId)) {
              teamRun.workerRunIds.push(workerRunId);
            }

            this.emit({
              type: "assignment_card",
              runId: teamRun.id,
              conversationId,
              agentId,
              teamRunId: teamRun.id,
              payload: { agentId, task: task.task, dependsOn: task.dependsOn },
            });
            this.emit({
              type: "public_text",
              runId: teamRun.id,
              conversationId,
              agentId,
              teamRunId: teamRun.id,
              payload: { text: `我收到任务了，开始在 ${workerWorktree.worktreePath} 中处理：${task.task}`, title: agent.name },
            });

            const result = await this.runner.run({
              run: {
                id: workerRunId,
                agentId,
                conversationId,
                status: "running",
                runtime: {
                  agentId,
                  displayName: agent.name,
                  provider: agent.provider,
                  role: agent.role,
                  worktreePath: workerWorktree.worktreePath,
                  branchName: workerWorktree.branchName,
                  status: "running",
                },
                prompt: workerPrompt,
                teamRunId: teamRun.id,
                createdAt: new Date().toISOString(),
                startedAt: new Date().toISOString(),
              },
              agent,
              prompt: workerPrompt,
              worktree: workerWorktree,
              emit: (event) => this.emitRunnerFailure(event, teamRun.id),
            });

            const diffPreview = await this.worktrees.getDiffPreview(workerWorktree);
            if (diffPreview.changedFiles.length > 0 || diffPreview.patch.trim()) {
              this.emit({
                type: "code_diff",
                runId: teamRun.id,
                conversationId,
                agentId,
                teamRunId: teamRun.id,
                payload: diffPreview,
              });
            }

            const sync = await this.worktrees.complete(workerWorktree, result.summary);
            if (sync.status === "failed") {
              throw new Error(sync.error?.message ?? "Worker changes failed to sync back to the target repository");
            }

            const taskResult: TeamTaskResult = {
              agentId,
              runId: workerRunId,
              status: "succeeded",
              output: result.output,
              diffPreview,
              sync,
            };
            taskResults.set(agentId, taskResult);
            completed.add(agentId);

            this.emit({
              type: "result_card",
              runId: teamRun.id,
              conversationId,
              agentId,
              teamRunId: teamRun.id,
              payload: {
                agentId,
                title: `${agent.name} 已完成`,
                status: "succeeded",
                summary: cleanAgentOutput(result.output),
              },
            });
            try {
              this.conversations.addAssistantMessage(
                conversationId,
                `${agent.name} 已完成：\n\n${cleanAgentOutput(result.output, 900)}`,
                agentId,
              );
            } catch {
              // event stream remains the primary real-time channel
            }
            this.emit({
              type: "public_text",
              runId: teamRun.id,
              conversationId,
              agentId,
              teamRunId: teamRun.id,
              payload: { text: cleanAgentOutput(result.output, 700), title: agent.name, variant: "success" },
            });

            return taskResult;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const failResult: TeamTaskResult = {
              agentId,
              runId: `${teamRun.id}-${agentId}`,
              status: "failed",
              output: message,
            };
            taskResults.set(agentId, failResult);
            completed.add(agentId);
            failed.add(agentId);

            this.emit({
              type: "result_card",
              runId: teamRun.id,
              conversationId,
              agentId,
              teamRunId: teamRun.id,
              payload: {
                agentId,
                title: `${agentId} 执行失败`,
                status: "failed",
                summary: message,
              },
            });
            try {
              this.conversations.addAssistantMessage(
                conversationId,
                `${agentId} 执行失败：${message}`,
                agentId,
              );
            } catch {
              // event stream remains the primary real-time channel
            }

            return failResult;
          }
        }),
      );

      teamRun.taskResults = [...teamRun.taskResults, ...batchResults];
      teamRun.updatedAt = new Date().toISOString();
      remaining = notReady;
    }

    const failedWorkerResults = [...taskResults.values()].filter((result) => result.status === "failed");
    if (failedWorkerResults.length > 0) {
      teamRun.verdict = {
        verdict: "rework",
        summary: `有 ${failedWorkerResults.length} 个任务失败，团队运行已停止。`,
        rework: Object.fromEntries(
          failedWorkerResults.map((result) => [result.agentId, cleanAgentOutput(result.output, 500)]),
        ),
      };
      teamRun.status = "failed";
      teamRun.updatedAt = new Date().toISOString();
      const finalSummary = buildFinalSummary(teamRun.workerRunIds.length, teamRun.taskResults, teamRun.verdict);
      try {
        this.conversations.addAssistantMessage(conversationId, finalSummary);
      } catch {
        // ignore
      }
      this.emit({
        type: "public_text",
        runId: teamRun.id,
        conversationId,
        agentId: leader.id,
        teamRunId: teamRun.id,
        payload: { text: finalSummary, title: "Orchestrator", variant: "error" },
      });
      this.emit({
        type: "result_card",
        runId: teamRun.id,
        conversationId,
        agentId: leader.id,
        teamRunId: teamRun.id,
        payload: {
          agentId: leader.id,
          title: "平台任务失败",
          status: "failed",
          summary: finalSummary,
        },
      });
      return;
    }

    // Phase 3 & 4: Leader Verification with rework loop
    teamRun.status = "verifying";
    teamRun.updatedAt = new Date().toISOString();

    this.emit({
      type: "public_text",
      runId: teamRun.id,
      conversationId,
      agentId: leader.id,
      teamRunId: teamRun.id,
      payload: { text: "所有已分派任务返回后，我正在汇总并检查结果是否满足原始需求。", title: "Orchestrator" },
    });

    let verdict: TeamVerdict | null = null;
    const allResults = [...taskResults.values()];

    for (let iteration = 0; iteration < MAX_REWORK_ITERATIONS; iteration++) {
      const verifyPrompt = buildLeaderVerificationPrompt(leader, request.prompt, plan, allResults);
      const verifyWorktree = await this.worktrees.prepare(
        `${teamRun.id}-verify-${iteration}`,
        request.repositoryPath,
      );

      const verifyResult = await this.runner.run({
        run: {
          id: `${teamRun.id}-verify-${iteration}`,
          agentId: leader.id,
          conversationId,
          status: "running",
          runtime: {
            agentId: leader.id,
            displayName: leader.name,
            provider: leader.provider,
            role: leader.role,
            worktreePath: verifyWorktree.worktreePath,
            branchName: verifyWorktree.branchName,
            status: "running",
          },
          prompt: verifyPrompt,
          teamRunId: teamRun.id,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
        },
        agent: leader,
        prompt: verifyPrompt,
        worktree: verifyWorktree,
        emit: (event) => this.emitRunnerFailure(event, teamRun.id),
      });

      teamRun.leaderRunIds.push(`${teamRun.id}-verify-${iteration}`);

      verdict = parseVerdictFromOutput(verifyResult.output);
      if (!verdict) {
        // If leader didn't produce a valid verdict, treat as rework with generic feedback
        verdict = {
          verdict: "rework",
          summary: "Leader did not produce a valid verdict.",
          rework: {},
        };
      }

      this.emit({
        type: "result_card",
        runId: teamRun.id,
        conversationId,
        agentId: leader.id,
        teamRunId: teamRun.id,
        payload: {
          agentId: leader.id,
          title: verdict.verdict === "complete" ? "Orchestrator 验收通过" : "Orchestrator 要求返工",
          status: verdict.verdict === "complete" ? "succeeded" : "failed",
          summary: verdict.summary,
        },
      });

      if (verdict.verdict === "complete") {
        break;
      }

      // Rework: re-run failed workers with feedback
      if (verdict.rework && Object.keys(verdict.rework).length > 0) {
        const reworkResults = await Promise.all(
          Object.entries(verdict.rework).map(async ([agentId, feedback]) => {
            try {
              const agent = this.agents.get(agentId);
              const reworkPrompt = [
                agent.systemPrompt ?? "You are a coding agent.",
                "",
                "Your previous work needs revision. Feedback from the leader:",
                feedback,
                "",
                "Please redo your task with the feedback applied.",
              ].join("\n");

              const reworkWorktree = await this.worktrees.prepare(
                `${teamRun.id}-${agentId}-rework-${iteration}`,
                request.repositoryPath,
              );
              const reworkRunId = `${teamRun.id}-${agentId}-rework-${iteration}`;
              if (!teamRun.workerRunIds.includes(reworkRunId)) {
                teamRun.workerRunIds.push(reworkRunId);
              }

              const result = await this.runner.run({
                run: {
                  id: reworkRunId,
                  agentId,
                  conversationId,
                  status: "running",
                  runtime: {
                    agentId,
                    displayName: agent.name,
                    provider: agent.provider,
                    role: agent.role,
                    worktreePath: reworkWorktree.worktreePath,
                    branchName: reworkWorktree.branchName,
                    status: "running",
                  },
                  prompt: reworkPrompt,
                  teamRunId: teamRun.id,
                  createdAt: new Date().toISOString(),
                  startedAt: new Date().toISOString(),
                },
                agent,
                prompt: reworkPrompt,
                worktree: reworkWorktree,
                emit: (event) => this.emitRunnerFailure(event, teamRun.id),
              });

              const diffPreview = await this.worktrees.getDiffPreview(reworkWorktree);
              if (diffPreview.changedFiles.length > 0 || diffPreview.patch.trim()) {
                this.emit({
                  type: "code_diff",
                  runId: teamRun.id,
                  conversationId,
                  agentId,
                  teamRunId: teamRun.id,
                  payload: diffPreview,
                });
              }
              const sync = await this.worktrees.complete(reworkWorktree, result.summary);
              if (sync.status === "failed") {
                throw new Error(sync.error?.message ?? "Rework changes failed to sync back to the target repository");
              }

              const updated: TeamTaskResult = {
                agentId,
                runId: reworkRunId,
                status: "succeeded",
                output: result.output,
                diffPreview,
                sync,
              };
              // Replace previous result
              const idx = allResults.findIndex((r) => r.agentId === agentId);
              if (idx >= 0) allResults[idx] = updated;
              else allResults.push(updated);
              taskResults.set(agentId, updated);

              return updated;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const failResult: TeamTaskResult = {
                agentId,
                runId: `${teamRun.id}-${agentId}-rework-${iteration}`,
                status: "failed",
                output: message,
              };
              const idx = allResults.findIndex((r) => r.agentId === agentId);
              if (idx >= 0) allResults[idx] = failResult;
              else allResults.push(failResult);
              return failResult;
            }
          }),
        );
        teamRun.taskResults = [...teamRun.taskResults, ...reworkResults];
      } else {
        // No specific rework targets — break to avoid infinite loop
        break;
      }
    }

    // Finalize
    teamRun.verdict = verdict ?? undefined;
    teamRun.status = verdict?.verdict === "complete" ? "succeeded" : "failed";
    teamRun.updatedAt = new Date().toISOString();

    // Add assistant message to conversation
    const finalSummary = buildFinalSummary(teamRun.workerRunIds.length, teamRun.taskResults, teamRun.verdict);
    try {
      this.conversations.addAssistantMessage(conversationId, finalSummary);
    } catch {
      // ignore
    }

    this.emit({
      type: "public_text",
      runId: teamRun.id,
      conversationId,
      agentId: leader.id,
      teamRunId: teamRun.id,
      payload: {
        text: finalSummary,
        title: "Orchestrator",
        variant: teamRun.status === "succeeded" ? "success" : "error",
      },
    });
    this.emit({
      type: "result_card",
      runId: teamRun.id,
      conversationId,
      agentId: leader.id,
      teamRunId: teamRun.id,
      payload: {
        agentId: leader.id,
        title: teamRun.status === "succeeded" ? "平台任务完成" : "平台任务失败",
        status: teamRun.status === "succeeded" ? "succeeded" : "failed",
        summary: finalSummary,
      },
    });
  }

  private emitRunnerFailure(event: Omit<AgentEvent, "eventId" | "seq" | "ts">, teamRunId: string): void {
    if (event.type !== "agent_failed" && event.type !== "agent_cancelled") {
      return;
    }
    this.emit({ ...event, teamRunId });
  }

  private emit(event: Omit<AgentEvent, "eventId" | "seq" | "ts">): void {
    this.eventSeq += 1;
    this.gateway.emitAgentEvent({
      ...event,
      eventId: createId("event"),
      seq: this.eventSeq,
      ts: Date.now(),
    });
  }
}
