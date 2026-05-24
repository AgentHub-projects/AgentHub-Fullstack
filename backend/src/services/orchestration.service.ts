import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type {
  AgentDto,
  AgentEvent,
  AgentRun,
  StartTeamRunRequest,
  TeamPlan,
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
  parts.push("Task:");
  parts.push(task);

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
    void this.executeTeamRun(teamRun, team.members, leader, workerMembers, request).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      teamRun.status = "failed";
      teamRun.updatedAt = new Date().toISOString();
      this.emit({
        type: "team_failed",
        runId: runId,
        conversationId,
        agentId: leader.id,
        teamRunId: runId,
        payload: { error: message },
      });
    });

    return teamRun;
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
      type: "team_planning",
      runId: teamRun.id,
      conversationId,
      agentId: leader.id,
      teamRunId: teamRun.id,
      payload: { message: "Leader is analyzing the request..." },
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
      emit: (event) => this.emit({ ...event, teamRunId: teamRun.id }),
    });

    teamRun.leaderRunIds.push(teamRun.id + "-plan");

    const plan = parsePlanFromOutput(planResult.output);
    if (!plan) {
      throw new Error("Leader did not produce a valid plan. Output: " + planResult.output.slice(0, 500));
    }
    teamRun.plan = plan;
    teamRun.status = "executing";
    teamRun.updatedAt = new Date().toISOString();

    this.emit({
      type: "team_plan_ready",
      runId: teamRun.id,
      conversationId,
      agentId: leader.id,
      teamRunId: teamRun.id,
      payload: { plan },
    });

    // Phase 2: Worker Execution (dependency-ordered)
    const workerMap = new Map(workerMembers.map((w) => [w.agentId, w]));
    const taskResults = new Map<string, TeamTaskResult>();
    const completed = new Set<string>();

    // Execute tasks in dependency order batches
    let remaining = [...plan.tasks];
    while (remaining.length > 0) {
      const ready: typeof plan.tasks = [];
      const notReady: typeof plan.tasks = [];

      for (const task of remaining) {
        const depsSatisfied = task.dependsOn.every((depId) => completed.has(depId));
        if (depsSatisfied) {
          ready.push(task);
        } else {
          notReady.push(task);
        }
      }

      if (ready.length === 0) {
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

            this.emit({
              type: "worker_assigned",
              runId: teamRun.id,
              conversationId,
              agentId,
              teamRunId: teamRun.id,
              payload: { agentId, task: task.task },
            });

            const result = await this.runner.run({
              run: {
                id: `${teamRun.id}-${agentId}`,
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
              emit: (event) => this.emit({ ...event, teamRunId: teamRun.id }),
            });

            teamRun.workerRunIds.push(`${teamRun.id}-${agentId}`);

            const taskResult: TeamTaskResult = {
              agentId,
              runId: `${teamRun.id}-${agentId}`,
              status: "succeeded",
              output: result.output,
            };
            taskResults.set(agentId, taskResult);
            completed.add(agentId);

            this.emit({
              type: "worker_result",
              runId: teamRun.id,
              conversationId,
              agentId,
              teamRunId: teamRun.id,
              payload: { agentId, status: "succeeded", output: result.output },
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

            this.emit({
              type: "worker_result",
              runId: teamRun.id,
              conversationId,
              agentId,
              teamRunId: teamRun.id,
              payload: { agentId, status: "failed", output: message },
            });

            return failResult;
          }
        }),
      );

      teamRun.taskResults = [...teamRun.taskResults, ...batchResults];
      teamRun.updatedAt = new Date().toISOString();
      remaining = notReady;
    }

    // Phase 3 & 4: Leader Verification with rework loop
    teamRun.status = "verifying";
    teamRun.updatedAt = new Date().toISOString();

    this.emit({
      type: "team_verifying",
      runId: teamRun.id,
      conversationId,
      agentId: leader.id,
      teamRunId: teamRun.id,
      payload: { message: "Leader is verifying results..." },
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
        emit: (event) => this.emit({ ...event, teamRunId: teamRun.id }),
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
        type: "team_verdict_ready",
        runId: teamRun.id,
        conversationId,
        agentId: leader.id,
        teamRunId: teamRun.id,
        payload: { verdict },
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

              const result = await this.runner.run({
                run: {
                  id: `${teamRun.id}-${agentId}-rework-${iteration}`,
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
                emit: (event) => this.emit({ ...event, teamRunId: teamRun.id }),
              });

              teamRun.workerRunIds.push(`${teamRun.id}-${agentId}-rework-${iteration}`);

              const updated: TeamTaskResult = {
                agentId,
                runId: `${teamRun.id}-${agentId}-rework-${iteration}`,
                status: "succeeded",
                output: result.output,
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
    try {
      const summary = verdict?.summary ?? "Team run completed.";
      this.conversations.addAssistantMessage(conversationId, summary);
    } catch {
      // ignore
    }

    this.emit({
      type: teamRun.status === "succeeded" ? "team_completed" : "team_failed",
      runId: teamRun.id,
      conversationId,
      agentId: leader.id,
      teamRunId: teamRun.id,
      payload: {
        status: teamRun.status,
        verdict: teamRun.verdict,
        taskResults: teamRun.taskResults,
      },
    });
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
