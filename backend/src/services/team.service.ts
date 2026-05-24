import { Injectable } from "@nestjs/common";
import type { CreateTeamRequest, TeamDto } from "@agenthub/shared";
import { createId } from "./ids";

const DEFAULT_TEAMS: TeamDto[] = [
  {
    id: "team-default",
    name: "Full-Stack Team",
    description: "Default full-stack development team with orchestrator, backend, and frontend agents.",
    members: [
      { agentId: "orchestrator", role: "leader" },
      { agentId: "backend-agent", role: "worker" },
      { agentId: "frontend-agent", role: "worker" },
    ],
    createdAt: new Date().toISOString(),
  },
];

@Injectable()
export class TeamService {
  private readonly teams = new Map<string, TeamDto>();

  constructor() {
    for (const team of DEFAULT_TEAMS) {
      this.teams.set(team.id, team);
    }
  }

  list(): { items: TeamDto[] } {
    return { items: [...this.teams.values()] };
  }

  get(id: string): TeamDto {
    const team = this.teams.get(id);
    if (!team) {
      throw Object.assign(new Error(`Team ${id} not found`), { statusCode: 404 });
    }
    return team;
  }

  create(request: CreateTeamRequest): TeamDto {
    const id = createId("team");
    const now = new Date().toISOString();
    const team: TeamDto = {
      id,
      name: request.name,
      description: request.description ?? "",
      members: request.members,
      createdAt: now,
    };
    this.teams.set(id, team);
    return team;
  }

  getLeaderMember(teamId: string): { agentId: string; role: "leader" } | undefined {
    const team = this.get(teamId);
    const leader = team.members.find((m) => m.role === "leader");
    if (!leader) {
      return undefined;
    }
    return leader as { agentId: string; role: "leader" };
  }

  getWorkerMembers(teamId: string): { agentId: string; role: "worker" }[] {
    const team = this.get(teamId);
    return team.members.filter(
      (m): m is { agentId: string; role: "worker" } => m.role === "worker",
    );
  }
}
