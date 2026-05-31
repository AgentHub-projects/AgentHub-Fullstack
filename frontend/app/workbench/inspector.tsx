"use client";

import { useEffect, useState } from "react";
import type React from "react";
import type {
  AgentInstanceDto,
  AgentTemplateDto,
  HubArtifactDto,
  HubEventDto,
  HubFileChangeDto,
} from "@agenthub/shared";
import {
  BranchesOutlined,
  CodeOutlined,
  FileDoneOutlined,
  FileMarkdownOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import { artifactContentUrl } from "../../lib/agenthub-api";
import {
  buildDiffLines,
  buildFileTreeRows,
  countChangeLines,
  diffMarker,
  parseUnifiedPatch,
} from "../../lib/workbench/diff";
import type { DiffLine } from "../../lib/workbench/types";
import { artifactLabel } from "../../lib/workbench/format";
import { RichText } from "./rich-text";

export function DiffPanel({ changes }: { changes: HubFileChangeDto[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (changes.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !changes.some((change) => change.id === selectedId)) {
      setSelectedId(changes[0].id);
    }
  }, [changes, selectedId]);

  if (changes.length === 0) return <PanelEmpty icon={<BranchesOutlined />} text="暂无文件变更" />;
  const activeChange = changes.find((change) => change.id === selectedId) ?? changes[0];
  const rows = buildFileTreeRows(changes);
  const additions = countChangeLines(activeChange, "add");
  const deletions = countChangeLines(activeChange, "remove");

  return (
    <div className="panelScroll diffPanelLayout">
      <section className="diffFileTree" aria-label="文件变更树">
        <div className="diffPanelHeader">
          <strong>Files</strong>
          <span>{changes.length}</span>
        </div>
        <div className="diffTreeRows">
          {rows.map((row) =>
            row.kind === "folder" ? (
              <div className="diffTreeFolder" key={row.key} style={{ paddingLeft: 10 + row.depth * 14 }}>
                {row.label}
              </div>
            ) : (
              <button
                className={`diffTreeFile ${row.change?.id === activeChange.id ? "active" : ""}`}
                key={row.key}
                type="button"
                onClick={() => row.change && setSelectedId(row.change.id)}
                style={{ paddingLeft: 10 + row.depth * 14 }}
              >
                <span>{row.label}</span>
                <code>{row.change?.changeType}</code>
              </button>
            ),
          )}
        </div>
      </section>

      <section className="diffViewerCard">
        <div className="diffViewerTop">
          <div>
            <strong>{activeChange.path}</strong>
            {activeChange.oldPath && <small>{activeChange.oldPath}</small>}
          </div>
          <span className={`changeType ${activeChange.changeType}`}>{activeChange.changeType}</span>
        </div>
        <div className="diffStats">
          <span className="add">+{additions}</span>
          <span className="remove">-{deletions}</span>
          {activeChange.afterTruncated || activeChange.beforeTruncated ? <span>内容已截断</span> : null}
        </div>
        <UnifiedDiffView change={activeChange} />
      </section>
    </div>
  );
}

export function ArtifactPanel({ artifacts }: { artifacts: HubArtifactDto[] }) {
  if (artifacts.length === 0) return <PanelEmpty icon={<FileDoneOutlined />} text="暂无 artifact" />;
  return (
    <div className="panelScroll">
      {artifacts.map((artifact) => (
        <article className="artifactBlock" key={artifact.id}>
          <div className="artifactTop">
            <span>{artifactIcon(artifact.kind)}</span>
            <div>
              <strong>{artifact.title}</strong>
              <small>{artifact.kind} · {artifact.mimeType} · v{artifact.version} · {artifact.final ? "final" : "draft"}</small>
            </div>
            <a title="打开内容" href={artifactContentUrl(artifact.id)} target="_blank" rel="noreferrer">
              <LinkOutlined />
            </a>
          </div>
          <ArtifactPreview artifact={artifact} />
        </article>
      ))}
    </div>
  );
}

export function InlineDiff({ event }: { event: HubEventDto }) {
  const patch = typeof event.payload.patch === "string" ? event.payload.patch : "";
  const path = typeof event.payload.path === "string" ? event.payload.path : "changed file";
  return (
    <div className="inlineArtifact">
      <strong><CodeOutlined /> {path}</strong>
      {patch ? <UnifiedDiffLines lines={parseUnifiedPatch(patch)} /> : <pre>{JSON.stringify(event.payload, null, 2)}</pre>}
    </div>
  );
}

export function InlineArtifact({ event }: { event: HubEventDto }) {
  const title = typeof event.payload.title === "string" ? event.payload.title : "Artifact";
  const content = typeof event.payload.content === "string" ? event.payload.content : "";
  return (
    <div className="inlineArtifact">
      <strong><FileMarkdownOutlined /> {title}</strong>
      {content ? <RichText text={content} /> : <pre>{JSON.stringify(event.payload, null, 2)}</pre>}
    </div>
  );
}

function ArtifactPreview({ artifact }: { artifact: HubArtifactDto }) {
  const contentUrl = artifactContentUrl(artifact.id);
  if (artifact.kind === "image") {
    return (
      <div className="mediaPreview">
        <img alt={artifact.title} src={contentUrl} />
      </div>
    );
  }

  if (artifact.kind === "pdf") {
    return <iframe className="documentFrame" title={artifact.title} src={contentUrl} />;
  }

  if (artifact.kind === "html" && artifact.textContent) {
    return <iframe className="documentFrame" title={artifact.title} srcDoc={artifact.textContent} sandbox="" />;
  }

  if (artifact.kind === "docx") {
    return (
      <div className="documentFallback">
        <FileDoneOutlined />
        <div>
          <strong>DOCX 原始文件</strong>
          <span>后端当前提供只读下载入口；接入 HTML render 后可在此处内联预览。</span>
        </div>
      </div>
    );
  }

  if (artifact.textContent) {
    return artifact.kind === "log" ? <pre>{artifact.textContent}</pre> : <RichText text={artifact.textContent} />;
  }

  return <code>{artifact.storageUri ?? "inline artifact"}</code>;
}

function UnifiedDiffView({ change }: { change: HubFileChangeDto }) {
  return <UnifiedDiffLines lines={buildDiffLines(change)} />;
}

function UnifiedDiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="unifiedDiff" role="table">
      {lines.map((line, index) => (
        <div className={`diffLine ${line.kind}`} key={`${index}-${line.oldLine ?? "x"}-${line.newLine ?? "x"}`} role="row">
          <span className="lineNo">{line.oldLine ?? ""}</span>
          <span className="lineNo">{line.newLine ?? ""}</span>
          <span className="lineMarker">{diffMarker(line.kind)}</span>
          <code>{line.text || " "}</code>
        </div>
      ))}
    </div>
  );
}

function PanelEmpty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="panelEmpty">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function artifactIcon(kind: HubArtifactDto["kind"]) {
  const label = artifactLabel(kind);
  if (label === "markdown") return <FileMarkdownOutlined />;
  if (label === "document") return <FileDoneOutlined />;
  return <CodeOutlined />;
}
