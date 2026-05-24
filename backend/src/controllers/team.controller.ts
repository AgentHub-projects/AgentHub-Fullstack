import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import type { CreateTeamRequest, StartTeamRunRequest, TeamDto, TeamRunDto } from "@agenthub/shared";
import { TeamService } from "../services/team.service";
import { OrchestrationService } from "../services/orchestration.service";

@Controller()
export class TeamController {
  constructor(
    @Inject(TeamService) private readonly teams: TeamService,
    @Inject(OrchestrationService) private readonly orchestration: OrchestrationService,
  ) {}

  @Get("teams")
  listTeams(): { items: TeamDto[] } {
    return this.teams.list();
  }

  @Post("teams")
  createTeam(@Body() body: CreateTeamRequest): TeamDto {
    return this.teams.create(body);
  }

  @Get("teams/:id")
  getTeam(@Param("id") id: string): TeamDto {
    return this.teams.get(id);
  }

  @Post("teams/:id/run")
  async startTeamRun(
    @Param("id") id: string,
    @Body() body: StartTeamRunRequest,
  ): Promise<TeamRunDto> {
    return this.orchestration.startTeamRun(id, body);
  }

  @Get("team-runs/:id")
  getTeamRun(@Param("id") id: string): TeamRunDto {
    return this.orchestration.getTeamRun(id);
  }
}
