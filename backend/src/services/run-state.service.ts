import { Inject, Injectable } from "@nestjs/common";
import type { RunStateDto } from "@agenthub/shared";
import {
  FACT_SOURCE_REPOSITORY,
  type FactSourceRepository
} from "./fact-source.repository";

@Injectable()
export class RunStateService {
  constructor(@Inject(FACT_SOURCE_REPOSITORY) private readonly repository: FactSourceRepository) {}

  async refresh(runId: string): Promise<RunStateDto> {
    const [timeline, messages, fileChanges, artifacts, contextItems] = await Promise.all([
      this.repository.listEvents(runId),
      this.repository.listMessages(runId),
      this.repository.listFileChanges(runId),
      this.repository.listArtifacts(runId),
      this.repository.listContextItems({ runId })
    ]);

    return {
      runId,
      timeline,
      messages,
      fileChanges,
      artifacts,
      contextItems
    };
  }
}
