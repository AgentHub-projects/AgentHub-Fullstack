import type {
  HubEventDto,
  HubFileChangeDto,
  HubMessageDto,
  HubMessagePartDto,
  HubRunDto,
} from "@agenthub/shared";

export type InspectorTab = "diff" | "artifacts";
export type DiffLineKind = "context" | "add" | "remove" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface FileTreeRow {
  key: string;
  depth: number;
  label: string;
  kind: "folder" | "file";
  change?: HubFileChangeDto;
}

export type ConversationItem =
  | { kind: "message"; id: string; ts: string; message: HubMessageDto }
  | {
      kind: "run";
      id: string;
      ts: string;
      run: HubRunDto;
      events: HubEventDto[];
      messages: HubMessageDto[];
    };

export interface AgentReplyBlockModel {
  id: string;
  messageId?: string;
  speakerId?: string | number | null;
  name: string;
  text: string;
  parts?: HubMessagePartDto[];
  timestamp: string;
  status?: string;
}

export interface MentionMatch {
  start: number;
  end: number;
  query: string;
}
