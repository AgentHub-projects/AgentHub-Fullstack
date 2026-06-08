"use client";

import { useEffect, useRef, useState } from "react";
import type React from "react";
import type {
  AgentInstanceDto,
  AgentTemplateDto,
  HubArtifactDto,
  HubArtifactVersionDto,
  HubEventDto,
  HubFileChangeDto,
  FilesystemEntryDto,
  FilesystemReadFileDto,
  SandboxFilesystemConnectionResponse,
  SessionDiffContextDto,
} from "@agenthub/shared";
import {
  BranchesOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  DownOutlined,
  EditOutlined,
  ExpandOutlined,
  EyeOutlined,
  FileDoneOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  LoadingOutlined,
  MoreOutlined,
  ReloadOutlined,
  RightOutlined,
  SaveOutlined,
  SearchOutlined,
  SelectOutlined,
} from "@ant-design/icons";
import {
  artifactContentUrl,
  connectMainGitSocket,
  connectSandboxFilesystemSocket,
  getMainGitFileDiff,
  getSandboxFilesystemConnection,
  listMainGitCommitFiles,
  listMainGitCommits,
  listArtifactVersions,
  type MainGitCommitDto,
  type MainGitDiffFileSummary,
  type MainGitFileDiffResponse,
  type SandboxFilesystemClient,
  type SocketState,
} from "../../lib/agenthub-api";
import { publicArtifactUrlFromArtifact, pptSlidesFromMetadata } from "../../lib/workbench/artifact-preview";
import {
  buildDiffLines,
  countChangeLines,
  diffMarker,
  parseUnifiedPatch,
} from "../../lib/workbench/diff";
import { buildTextEdits, sortFilesystemEntries } from "../../lib/workbench/filesystem";
import {
  type SandboxDiffSessionState,
  isFilesystemDraftChange,
  isSandboxObservedChange,
  sandboxDiffLabel,
} from "../../lib/workbench/sandbox-diff";
import type { DiffLine } from "../../lib/workbench/types";
import {
  artifactLabel,
  fileChangeApplyLabel,
  fileChangeApplyMessage,
  fileChangeApplyStatus,
} from "../../lib/workbench/format";
import { RichText } from "./rich-text";
import { formatBytes, languageFromPath } from "../../lib/utils";

export function DiffPanel({
  changes,
  diffContext,
  sandboxState,
  sandboxDisabledReason,
  applyingId,
  onApply,
  onOpenFile,
  onRefreshSandboxFile,
  onSetSandboxBaseline,
}: {
  changes: HubFileChangeDto[];
  diffContext?: SessionDiffContextDto | null;
  sandboxState?: SandboxDiffSessionState;
  sandboxDisabledReason?: string;
  applyingId?: string | null;
  onApply?: (change: HubFileChangeDto) => void;
  onOpenFile?: (path: string) => void;
  onRefreshSandboxFile?: (change: HubFileChangeDto) => void;
  onSetSandboxBaseline?: (change: HubFileChangeDto) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedFileIds, setExpandedFileIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (changes.length === 0) {
      setSelectedId(null);
      setExpandedFileIds(new Set());
      return;
    }
    if (!selectedId || !changes.some((change) => change.id === selectedId)) {
      setSelectedId(changes[0].id);
    }

    const ids = new Set(changes.map((change) => change.id));
    setExpandedFileIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      if (next.size === 0) next.add(selectedId && ids.has(selectedId) ? selectedId : changes[0].id);
      return sameStringSet(current, next) ? current : next;
    });
  }, [changes, selectedId]);

  if (changes.length === 0) {
    return <PanelEmpty icon={<BranchesOutlined />} text={diffEmptyText(sandboxState, sandboxDisabledReason)} />;
  }
  const activeChange = changes.find((change) => change.id === selectedId) ?? changes[0];
  const localBaselineActive = changes.some((change) => isSandboxObservedChange(change) || isFilesystemDraftChange(change));

  function toggleFile(change: HubFileChangeDto) {
    setSelectedId(change.id);
    setExpandedFileIds((current) => {
      const next = new Set(current);
      if (next.has(change.id)) next.delete(change.id);
      else next.add(change.id);
      return next;
    });
  }

  function openFile(change: HubFileChangeDto) {
    setSelectedId(change.id);
    setExpandedFileIds((current) => {
      if (current.has(change.id)) return current;
      return new Set(current).add(change.id);
    });
  }

  return (
    <div className="panelScroll diffPanelLayout">
      <section className="diffReviewOverview" aria-label="文件变更总览">
        <DiffBranchContext context={diffContext} localBaselineActive={localBaselineActive} sandboxState={sandboxState} />
        <div className="diffReviewFiles">
          {changes.map((change) => {
            const expanded = expandedFileIds.has(change.id);
            const applyStatus = fileChangeApplyStatus(change);
            const active = change.id === activeChange.id;
            return (
              <article className={`diffFileBlock ${active ? "active" : ""} ${expanded ? "expanded" : ""}`} key={change.id}>
                <div className="diffReviewFile">
                  <button
                    className="diffFileToggle"
                    type="button"
                    title={expanded ? "收起文件 Diff" : "展开文件 Diff"}
                    aria-label={expanded ? `收起 ${change.path}` : `展开 ${change.path}`}
                    aria-expanded={expanded}
                    onClick={() => toggleFile(change)}
                  >
                    {expanded ? <DownOutlined /> : <RightOutlined />}
                  </button>
                  <button className="diffReviewFileMain" type="button" onClick={() => openFile(change)}>
                    <span>{change.path}</span>
                    {active && <span className="diffReviewActiveDot" aria-hidden="true" />}
                  </button>
                  <div className="diffReviewFileSide">
                    <span className="diffReviewFileStats">
                      <span className="add">+{countChangeLines(change, "add")}</span>
                      <span className="remove">-{countChangeLines(change, "remove")}</span>
                    </span>
                    <DiffFileStatus
                      change={change}
                      applyStatus={applyStatus}
                      applying={applyingId === change.id}
                      onApply={onApply}
                      onOpenFile={onOpenFile}
                      onRefreshSandboxFile={onRefreshSandboxFile}
                      onSetSandboxBaseline={onSetSandboxBaseline}
                    />
                  </div>
                </div>
                <DiffFileDetails change={change} expanded={expanded} />
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

const MAIN_GIT_COMMIT_LIMIT = 100;

type MainGitDiffCacheState = {
  commits: MainGitCommitDto[];
  hasMore: boolean;
  nextCursor: string;
  selectedSha: string;
  selectedFilePath: string;
  fileFilter: string;
  fileListVisible: boolean;
  filesByCommit: Record<string, MainGitDiffFileSummary[]>;
  parentsByCommit: Record<string, string>;
  fileDiffs: Record<string, MainGitFileDiffResponse>;
};

const mainGitConnectionCache = new Map<string, string>();
const mainGitDiffCache = new Map<string, MainGitDiffCacheState>();

function mainGitCachedStateForSession(sessionId: string) {
  const downstreamSessionId = sessionId ? (mainGitConnectionCache.get(sessionId) ?? "") : "";
  return {
    downstreamSessionId,
    state: downstreamSessionId ? mainGitDiffCache.get(downstreamSessionId) : undefined,
  };
}

export function MainGitDiffPanel({
  sessionId,
  refreshSignal,
  onNotice,
}: {
  sessionId: string;
  refreshSignal?: number;
  onNotice?: (message: string) => void;
}) {
  const initialCacheRef = useRef(mainGitCachedStateForSession(sessionId));
  const initialCache = initialCacheRef.current.state;
  const [commits, setCommits] = useState<MainGitCommitDto[]>(() => initialCache?.commits ?? []);
  const [downstreamSessionId, setDownstreamSessionId] = useState(() => initialCacheRef.current.downstreamSessionId);
  const [selectedSha, setSelectedSha] = useState(() => initialCache?.selectedSha ?? "");
  const [hasMore, setHasMore] = useState(() => initialCache?.hasMore ?? false);
  const [nextCursor, setNextCursor] = useState(() => initialCache?.nextCursor ?? "");
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [commitError, setCommitError] = useState("");
  const [socketState, setSocketState] = useState<SocketState>("disconnected");
  const [newCommitNotice, setNewCommitNotice] = useState("");
  const [filesByCommit, setFilesByCommit] = useState<Record<string, MainGitDiffFileSummary[]>>(
    () => initialCache?.filesByCommit ?? {},
  );
  const [parentsByCommit, setParentsByCommit] = useState<Record<string, string>>(
    () => initialCache?.parentsByCommit ?? {},
  );
  const [filesLoading, setFilesLoading] = useState<Record<string, boolean>>({});
  const [filesError, setFilesError] = useState<Record<string, string>>({});
  const [selectedFilePath, setSelectedFilePath] = useState(() => initialCache?.selectedFilePath ?? "");
  const [fileFilter, setFileFilter] = useState(() => initialCache?.fileFilter ?? "");
  const [fileListVisible, setFileListVisible] = useState(() => initialCache?.fileListVisible ?? true);
  const [openCommitMenu, setOpenCommitMenu] = useState<"" | "parent" | "target">("");
  const [fileDiffs, setFileDiffs] = useState<Record<string, MainGitFileDiffResponse>>(
    () => initialCache?.fileDiffs ?? {},
  );
  const [fileDiffLoading, setFileDiffLoading] = useState<Record<string, boolean>>({});
  const [fileDiffErrors, setFileDiffErrors] = useState<Record<string, string>>({});
  const selectedShaRef = useRef("");
  const latestShaRef = useRef("");
  const refreshSignalMountedRef = useRef(false);
  const cacheReadyRef = useRef(Boolean(initialCacheRef.current.downstreamSessionId));
  const skipNextCacheSaveRef = useRef("");
  const preserveSelectionOnShaChangeRef = useRef(Boolean(initialCache));

  const latestSha = commits[0]?.commitSha ?? "";
  const selectedFiles = selectedSha ? (filesByCommit[selectedSha] ?? []) : [];
  const normalizedFileFilter = fileFilter.trim().toLowerCase();
  const filteredFiles = normalizedFileFilter
    ? selectedFiles.filter((file) =>
        [file.path, file.oldPath ?? ""].some((value) => value.toLowerCase().includes(normalizedFileFilter)),
      )
    : selectedFiles;
  const filteredFileGroups = groupMainGitFiles(filteredFiles);
  const selectedFile = selectedFiles.find((file) => file.path === selectedFilePath) ?? null;
  const selectedFileKey = selectedFile && selectedSha ? mainGitFileKey(selectedSha, selectedFile.path) : "";
  const selectedFileDiff = selectedFileKey ? fileDiffs[selectedFileKey] : undefined;
  const selectedFileDiffLoading = selectedFileKey ? Boolean(fileDiffLoading[selectedFileKey]) : false;
  const selectedFileDiffError = selectedFileKey ? fileDiffErrors[selectedFileKey] : "";
  const selectedFilesLoading = selectedSha ? Boolean(filesLoading[selectedSha]) : false;
  const selectedFilesError = selectedSha ? filesError[selectedSha] : "";
  const selectedParentSha = selectedSha ? (parentsByCommit[selectedSha] ?? "") : "";
  const selectedFilesLoaded = Boolean(selectedSha && filesByCommit[selectedSha]);
  const parentRefText = selectedParentSha ? shortSha(selectedParentSha) : selectedFilesLoaded ? "empty tree" : "加载中";
  const parentRefTitle = selectedParentSha || (selectedFilesLoaded ? "empty tree" : "正在读取父 commit");
  const selectedTotals = selectedFiles.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  useEffect(() => {
    selectedShaRef.current = selectedSha;
  }, [selectedSha]);

  useEffect(() => {
    latestShaRef.current = latestSha;
  }, [latestSha]);

  useEffect(() => {
    if (!sessionId) {
      cacheReadyRef.current = false;
      setDownstreamSessionId("");
      restoreMainGitCacheState();
      return;
    }

    const cachedDownstreamSessionId = mainGitConnectionCache.get(sessionId);
    if (cachedDownstreamSessionId) {
      setDownstreamSessionId(cachedDownstreamSessionId);
      return;
    }

    cacheReadyRef.current = false;
    setDownstreamSessionId("");
    restoreMainGitCacheState();
    let cancelled = false;
    void getSandboxFilesystemConnection(sessionId).then((result) => {
      if (cancelled || !result.ok) return;
      mainGitConnectionCache.set(sessionId, result.data.downstreamSessionId);
      setDownstreamSessionId(result.data.downstreamSessionId);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!downstreamSessionId) return;
    const cached = mainGitDiffCache.get(downstreamSessionId);
    const viewingLatest = cached ? !cached.selectedSha || cached.selectedSha === cached.commits[0]?.commitSha : true;
    skipNextCacheSaveRef.current = downstreamSessionId;
    cacheReadyRef.current = true;
    preserveSelectionOnShaChangeRef.current = Boolean(cached);
    // 只恢复 UI 状态，不恢复文件/commit 数据（避免旧缓存与刷新后的 commit 列表不匹配）
    if (cached) {
      setSelectedFilePath(cached.selectedFilePath ?? "");
      setFileFilter(cached.fileFilter ?? "");
      setFileListVisible(cached.fileListVisible ?? true);
    }
    void refreshCommitList({ selectLatest: viewingLatest, silent: Boolean(cached) });
  }, [downstreamSessionId]);

  useEffect(() => {
    if (!downstreamSessionId || !cacheReadyRef.current) return;
    if (skipNextCacheSaveRef.current === downstreamSessionId) {
      skipNextCacheSaveRef.current = "";
      return;
    }
    mainGitDiffCache.set(downstreamSessionId, {
      commits,
      hasMore,
      nextCursor,
      selectedSha,
      selectedFilePath,
      fileFilter,
      fileListVisible,
      filesByCommit,
      parentsByCommit,
      fileDiffs,
    });
  }, [
    downstreamSessionId,
    commits,
    hasMore,
    nextCursor,
    selectedSha,
    selectedFilePath,
    fileFilter,
    fileListVisible,
    filesByCommit,
    parentsByCommit,
    fileDiffs,
  ]);

  useEffect(() => {
    if (!refreshSignalMountedRef.current) {
      refreshSignalMountedRef.current = true;
      return;
    }
    const shouldSelectLatest = !selectedShaRef.current || selectedShaRef.current === latestShaRef.current;
    void refreshCommitList({ selectLatest: shouldSelectLatest, silent: true });
  }, [refreshSignal]);

  useEffect(() => {
    if (!downstreamSessionId) return;
    return connectMainGitSocket(downstreamSessionId, {
      onState: setSocketState,
      onCommitted: () => {
        const viewingLatest = !selectedShaRef.current || selectedShaRef.current === latestShaRef.current;
        setNewCommitNotice(viewingLatest ? "" : "main 有新提交，当前仍停留在历史 commit");
        if (!viewingLatest) onNotice?.("main 有新提交，已刷新提交列表，当前仍停留在历史 commit");
        void refreshCommitList({ selectLatest: viewingLatest, silent: true });
      },
    });
  }, [downstreamSessionId, onNotice]);

  useEffect(() => {
    if (!preserveSelectionOnShaChangeRef.current) {
      setSelectedFilePath("");
      setFileFilter("");
    }
    preserveSelectionOnShaChangeRef.current = false;
    setOpenCommitMenu("");
    if (selectedSha) void loadCommitFiles(selectedSha);
  }, [selectedSha]);

  useEffect(() => {
    if (!selectedSha || selectedFiles.length === 0) {
      setSelectedFilePath("");
      return;
    }
    if (!selectedFiles.some((file) => file.path === selectedFilePath)) {
      setSelectedFilePath(selectedFiles[0].path);
    }
  }, [selectedSha, selectedFiles, selectedFilePath]);

  useEffect(() => {
    if (selectedSha && selectedFilePath) void loadFileDiff(selectedSha, selectedFilePath);
  }, [selectedSha, selectedFilePath]);

  async function refreshCommitList(options: { selectLatest?: boolean; silent?: boolean } = {}) {
    if (!downstreamSessionId) return;
    if (!options.silent) {
      setLoadingCommits(true);
      setFilesByCommit({});
      setFileDiffs({});
      setFileDiffErrors({});
    }
    setCommitError("");
    const result = await listMainGitCommits(downstreamSessionId, { limit: MAIN_GIT_COMMIT_LIMIT });
    if (!options.silent) setLoadingCommits(false);
    if (!result.ok) {
      setCommitError(result.error);
      return;
    }

    setCommits((current) => mergeCommits(result.data.items, current));
    setHasMore(result.data.hasMore);
    setNextCursor(result.data.nextCursor);
    const nextSelected = options.selectLatest
      ? result.data.items[0]?.commitSha
      : selectedShaRef.current || result.data.items[0]?.commitSha;
    setSelectedSha(nextSelected ?? "");
  }

  async function loadMoreCommits() {
    if (!hasMore || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    const result = await listMainGitCommits(downstreamSessionId, { limit: MAIN_GIT_COMMIT_LIMIT, cursor: nextCursor });
    setLoadingMore(false);
    if (!result.ok) {
      setCommitError(result.error);
      return;
    }
    setCommits((current) => mergeCommits(current, result.data.items));
    setHasMore(result.data.hasMore);
    setNextCursor(result.data.nextCursor);
  }

  async function loadCommitFiles(commitSha: string) {
    if (filesByCommit[commitSha] || filesLoading[commitSha]) return;
    const cached = downstreamSessionId ? mainGitDiffCache.get(downstreamSessionId) : undefined;
    const cachedFiles = cached?.filesByCommit[commitSha];
    if (cachedFiles) {
      setFilesByCommit((current) => (current[commitSha] ? current : { ...current, [commitSha]: cachedFiles }));
      const cachedParent = cached?.parentsByCommit[commitSha];
      if (cachedParent !== undefined) {
        setParentsByCommit((current) => ({ ...current, [commitSha]: cachedParent }));
      }
      return;
    }
    setFilesLoading((current) => ({ ...current, [commitSha]: true }));
    setFilesError((current) => ({ ...current, [commitSha]: "" }));
    const result = await listMainGitCommitFiles(downstreamSessionId, commitSha);
    setFilesLoading((current) => ({ ...current, [commitSha]: false }));
    if (!result.ok) {
      setFilesError((current) => ({ ...current, [commitSha]: result.error }));
      return;
    }
    setFilesByCommit((current) => ({ ...current, [commitSha]: result.data.files }));
    setParentsByCommit((current) => ({ ...current, [commitSha]: result.data.parentCommitSha }));
  }

  async function loadFileDiff(commitSha: string, path: string) {
    const key = mainGitFileKey(commitSha, path);
    if (fileDiffs[key] || fileDiffLoading[key] || fileDiffErrors[key]) return;
    const cachedDiff = downstreamSessionId ? mainGitDiffCache.get(downstreamSessionId)?.fileDiffs[key] : undefined;
    if (cachedDiff) {
      setFileDiffs((current) => (current[key] ? current : { ...current, [key]: cachedDiff }));
      return;
    }
    setFileDiffLoading((current) => ({ ...current, [key]: true }));
    setFileDiffErrors((current) => ({ ...current, [key]: "" }));
    const result = await getMainGitFileDiff(downstreamSessionId, commitSha, path);
    setFileDiffLoading((current) => ({ ...current, [key]: false }));
    if (!result.ok) {
      setFileDiffErrors((current) => ({ ...current, [key]: result.error }));
      return;
    }
    setFileDiffs((current) => ({ ...current, [key]: result.data }));
  }

  function selectFile(file: MainGitDiffFileSummary) {
    if (!selectedSha) return;
    setSelectedFilePath(file.path);
    void loadFileDiff(selectedSha, file.path);
  }

  function selectTargetCommit(commitSha: string) {
    setSelectedSha(commitSha);
    setOpenCommitMenu("");
  }

  function handleRefreshClick() {
    const shouldSelectLatest = !selectedShaRef.current || selectedShaRef.current === latestShaRef.current;
    setNewCommitNotice("");
    void refreshCommitList({ selectLatest: shouldSelectLatest });
  }

  function handleCommitMenuOpenChange(menuId: "parent" | "target", open: boolean) {
    setOpenCommitMenu((current) => (open ? menuId : current === menuId ? "" : current));
  }

  function restoreMainGitCacheState(cached?: MainGitDiffCacheState) {
    setCommits(cached?.commits ?? []);
    setSelectedSha(cached?.selectedSha ?? "");
    setHasMore(cached?.hasMore ?? false);
    setNextCursor(cached?.nextCursor ?? "");
    setLoadingCommits(false);
    setLoadingMore(false);
    setCommitError("");
    setNewCommitNotice("");
    setFilesByCommit(cached?.filesByCommit ?? {});
    setParentsByCommit(cached?.parentsByCommit ?? {});
    setFilesLoading({});
    setFilesError({});
    setSelectedFilePath(cached?.selectedFilePath ?? "");
    setFileFilter(cached?.fileFilter ?? "");
    setFileListVisible(cached?.fileListVisible ?? true);
    setOpenCommitMenu("");
    setFileDiffs(cached?.fileDiffs ?? {});
    setFileDiffLoading({});
    setFileDiffErrors({});
    selectedShaRef.current = cached?.selectedSha ?? "";
    latestShaRef.current = cached?.commits[0]?.commitSha ?? "";
  }

  return (
    <div className="panelScroll diffPanelLayout mainGitDiffPanel">
      <header className="mainGitToolbar" aria-label="Diff 工具栏">
        <div className="mainGitToolbarTitle">
          <strong>提交</strong>
          <DownOutlined />
          {selectedFilesLoaded && (
            <span className="mainGitToolbarTotals" aria-label="本次总变更量">
              <span className="add">+{formatCount(selectedTotals.additions)}</span>
              <span className="remove">-{formatCount(selectedTotals.deletions)}</span>
            </span>
          )}
        </div>
        <div className="mainGitToolbarActions">
          <button type="button" title="更多操作" aria-label="更多操作">
            <MoreOutlined />
          </button>
          <button
            type="button"
            title="刷新"
            aria-label="刷新"
            disabled={loadingCommits}
            onClick={handleRefreshClick}
          >
            {loadingCommits ? <LoadingOutlined /> : <ReloadOutlined />}
          </button>
          <button
            className={fileListVisible ? "active" : ""}
            type="button"
            title={fileListVisible ? "隐藏文件列表" : "显示文件列表"}
            aria-label={fileListVisible ? "隐藏文件列表" : "显示文件列表"}
            aria-pressed={fileListVisible}
            onClick={() => setFileListVisible((value) => !value)}
          >
            <FolderOpenOutlined />
          </button>
        </div>
      </header>

      <section className="mainGitRevisionBar" aria-label="commit 对比">
        <div className="mainGitRevisionRefs">
          <MainGitCommitPicker
            activeSha={selectedSha}
            commits={commits}
            disabled={commits.length === 0}
            hasMore={hasMore}
            label={selectedSha ? shortSha(selectedSha) : "未选择 commit"}
            loadingMore={loadingMore}
            menuId="target"
            onLoadMore={loadMoreCommits}
            onOpenChange={(open) => handleCommitMenuOpenChange("target", open)}
            onSelect={selectTargetCommit}
            open={openCommitMenu === "target"}
            title={selectedSha || "未选择 commit"}
          />
          <span aria-hidden="true">→</span>
          <span className="mainGitCommitPicker disabled" title={parentRefTitle}>
            {parentRefText}
          </span>
        </div>
      </section>

      <section className={`mainGitDiffWorkspace ${fileListVisible ? "" : "fileListHidden"}`} aria-label="commit 文件变更">
        <main className="mainGitDiffContent" aria-label="Diff 内容">
          {loadingCommits && commits.length === 0 && <PanelEmpty icon={<LoadingOutlined />} text="正在加载 main 提交历史" />}
          {!loadingCommits && commits.length === 0 && !commitError && (
            <MainGitEmptyState title="尚无文件更改" text="此项目中的更改将显示在此处。" />
          )}
          {commitError && <div className="diffSnapshotNotice error">提交历史加载失败：{commitError}</div>}
          {newCommitNotice && <div className="diffSnapshotNotice">{newCommitNotice}</div>}
          {selectedFilesLoading && <PanelEmpty icon={<LoadingOutlined />} text="正在加载文件列表" />}
          {selectedFilesError && <div className="diffSnapshotNotice error">文件列表加载失败：{selectedFilesError}</div>}
          {selectedSha && !selectedFilesLoading && !selectedFilesError && selectedFiles.length === 0 && (
            <MainGitEmptyState title="尚无文件更改" text="此项目中的更改将显示在此处。" />
          )}
          {selectedSha && selectedFile && selectedFiles.length > 0 && (
            <MainGitSelectedDiff
              file={selectedFile}
              diff={selectedFileDiff}
              loading={selectedFileDiffLoading}
              error={selectedFileDiffError}
            />
          )}
          {selectedSha && !selectedFile && selectedFiles.length > 0 && (
            <MainGitEmptyState title="选择文件查看更改" text="右侧文件列表中的更改会显示在此处。" />
          )}
        </main>

        {fileListVisible && (
          <aside className="mainGitFilePanel" aria-label="变更文件">
            <label className="mainGitFileSearch">
              <SearchOutlined />
              <input
                value={fileFilter}
                placeholder="筛选文件..."
                onChange={(event) => setFileFilter(event.target.value)}
              />
            </label>
            <div className="mainGitFilesSummary">
              <span>{selectedFiles.length} 个文件</span>
            </div>
            {selectedFilesLoading && <span className="mainGitFilePanelNote">正在加载文件列表</span>}
            {!selectedFilesLoading && selectedFiles.length > 0 && filteredFiles.length === 0 && (
              <span className="mainGitFilePanelNote">没有匹配的文件</span>
            )}
            {!selectedFilesLoading && selectedFiles.length === 0 && (
              <span className="mainGitFilePanelNote">没有匹配的文件</span>
            )}
            <div className="mainGitFileList">
              {filteredFileGroups.map((group) => (
                <div className="mainGitFileGroup" key={group.directory}>
                  <div className="mainGitFileGroupHeader" title={group.directory}>
                    <DownOutlined />
                    <span>{group.directory}</span>
                  </div>
                  {group.files.map((file) => (
                    <button
                      className={`mainGitFileNode ${file.path === selectedFilePath ? "active" : ""}`}
                      key={file.path}
                      type="button"
                      title={`${mainGitStatusLabel(file.status)} · ${file.path} · +${file.additions} -${file.deletions}`}
                      onClick={() => selectFile(file)}
                    >
                      <span className={`mainGitFileIcon ${mainGitFileIconClass(file.path)}`}>
                        {mainGitFileIconLabel(file.path)}
                      </span>
                      <span className="mainGitFileName">{fileNameFromPath(file.path)}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </aside>
        )}
      </section>
    </div>
  );
}

function MainGitSelectedDiff({
  file,
  diff,
  loading,
  error,
}: {
  file: MainGitDiffFileSummary;
  diff?: MainGitFileDiffResponse;
  loading: boolean;
  error?: string;
}) {
  return (
    <section className="mainGitSelectedDiff">
      <header className="mainGitSelectedDiffHeader">
        <button className="mainGitSelectedDiffToggle" type="button" aria-label="当前文件已展开" title="当前文件已展开">
          <DownOutlined />
        </button>
        <div className="mainGitSelectedDiffTitle">
          <strong title={file.path}>{fileNameFromPath(file.path)}</strong>
          {file.oldPath && file.oldPath !== file.path && <small>{file.oldPath} → {file.path}</small>}
        </div>
        <div className="mainGitSelectedDiffMeta">
          <span className="add">+{file.additions}</span>
          <span className="remove">-{file.deletions}</span>
          <button type="button" title="在文件列表中定位" aria-label="在文件列表中定位">
            <ExpandOutlined />
          </button>
        </div>
      </header>
      <MainGitFileDiffDetails diff={diff} loading={loading} error={error} />
    </section>
  );
}

function MainGitCommitPicker({
  activeSha,
  commits,
  disabled,
  hasMore,
  label,
  loadingMore,
  menuId,
  onLoadMore,
  onOpenChange,
  onSelect,
  open,
  title,
}: {
  activeSha: string;
  commits: MainGitCommitDto[];
  disabled: boolean;
  hasMore: boolean;
  label: string;
  loadingMore: boolean;
  menuId: "parent" | "target";
  onLoadMore: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onSelect: (commitSha: string) => void;
  open: boolean;
  title: string;
}) {
  if (disabled) {
    return (
      <span className="mainGitCommitPicker disabled" title={title}>
        {label}
      </span>
    );
  }

  return (
    <details
      className={`mainGitCommitPicker ${menuId}`}
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary aria-label="选择 commit" title={title}>
        <span>{label}</span>
        <DownOutlined />
      </summary>
      <div className="mainGitCommitMenu" role="listbox" aria-label="commit 历史">
        {commits.map((commit) => (
          <button
            className={commit.commitSha === activeSha ? "active" : ""}
            key={commit.commitSha}
            type="button"
            role="option"
            aria-selected={commit.commitSha === activeSha}
            title={`${commit.commitSha} · ${commitSubject(commit)}`}
            onClick={() => onSelect(commit.commitSha)}
          >
            <span className="mainGitCommitMenuSha">{shortSha(commit.commitSha)}</span>
            <span className="mainGitCommitMenuSubject">{commitSubject(commit)}</span>
            <span className="mainGitCommitMenuTime">{formatDateTime(commit.committedAt)}</span>
          </button>
        ))}
        {hasMore && (
          <button
            className="mainGitCommitMenuMore"
            type="button"
            disabled={loadingMore}
            onClick={(event) => {
              event.preventDefault();
              void onLoadMore();
            }}
          >
            {loadingMore ? "加载中" : "加载更多"}
          </button>
        )}
      </div>
    </details>
  );
}

function MainGitEmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="mainGitEmptyState">
      <div className="mainGitEmptyIcon" aria-hidden="true">
        <FileOutlined />
        <span>+</span>
      </div>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

function MainGitFileDiffDetails({
  diff,
  loading,
  error,
}: {
  diff?: MainGitFileDiffResponse;
  loading: boolean;
  error?: string;
}) {
  return (
    <section className="diffViewerCard expanded">
      {loading && <PanelEmpty icon={<LoadingOutlined />} text="正在加载文件 Diff" />}
      {error && <div className="diffSnapshotNotice error">文件 Diff 加载失败：{error}</div>}
      {!loading && !error && diff?.baseFile.isBinary && !diff.patch?.trim() && (
        <div className="diffSnapshotNotice">二进制文件没有可展示的文本 diff。</div>
      )}
      {!loading && !error && diff?.patch?.trim() && (
        <UnifiedDiffLines
          variant="git"
          lines={parseUnifiedPatch(diff.patch).filter((line) => line.kind !== "meta" || line.text.startsWith("@@"))}
        />
      )}
      {!loading && !error && diff && !diff.patch?.trim() && !diff.baseFile.isBinary && (
        <div className="diffSnapshotNotice">下游未返回该文件的 patch。</div>
      )}
    </section>
  );
}

function mergeCommits(primary: MainGitCommitDto[], secondary: MainGitCommitDto[]) {
  const seen = new Set<string>();
  const result: MainGitCommitDto[] = [];
  for (const commit of [...primary, ...secondary]) {
    if (seen.has(commit.commitSha)) continue;
    seen.add(commit.commitSha);
    result.push(commit);
  }
  return result;
}

function mainGitFileKey(commitSha: string, path: string) {
  return `${commitSha}:${path}`;
}

function shortSha(value: string) {
  return value.slice(0, 12);
}

function commitSubject(commit: MainGitCommitDto) {
  return commit.comment.trim().split(/\r?\n/)[0]?.trim() || "无提交说明";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function mainGitStatusLabel(status: MainGitDiffFileSummary["status"]) {
  if (status === "added") return "新增";
  if (status === "deleted") return "删除";
  if (status === "renamed") return "重命名";
  return "修改";
}

function groupMainGitFiles(files: MainGitDiffFileSummary[]) {
  const groups = new Map<string, MainGitDiffFileSummary[]>();
  for (const file of files) {
    const directory = directoryFromPath(file.path);
    groups.set(directory, [...(groups.get(directory) ?? []), file]);
  }
  return Array.from(groups, ([directory, groupFiles]) => ({ directory, files: groupFiles }));
}

function directoryFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? parts.join("/") : ".";
}

function mainGitFileIconLabel(path: string) {
  const ext = fileExtension(path);
  if (ext === "tsx" || ext === "jsx") return "⚛";
  if (ext === "css") return "CSS";
  if (ext === "ts" || ext === "js") return "{}";
  if (ext === "md" || ext === "mdx") return "MD";
  return "";
}

function mainGitFileIconClass(path: string) {
  const ext = fileExtension(path);
  if (ext === "tsx" || ext === "jsx") return "react";
  if (ext === "css") return "css";
  if (ext === "ts" || ext === "js") return "code";
  if (ext === "md" || ext === "mdx") return "markdown";
  return "file";
}

function fileExtension(path: string) {
  const name = fileNameFromPath(path);
  const ext = name.includes(".") ? name.split(".").at(-1) : "";
  return ext?.toLowerCase() ?? "";
}

function DiffBranchContext({
  context,
  localBaselineActive,
  sandboxState,
}: {
  context?: SessionDiffContextDto | null;
  localBaselineActive?: boolean;
  sandboxState?: SandboxDiffSessionState;
}) {
  const baseRef = localBaselineActive ? "浏览器观测基线" : context?.baseRef ?? "main";
  const targetRef = localBaselineActive ? "当前沙箱文件" : context?.targetRef ?? "working tree";
  const showSandboxContext = Boolean(localBaselineActive && sandboxState);
  const showProjectContext = Boolean(!showSandboxContext && context?.projectName);
  return (
    <details className="diffBranchContext">
      <summary>
        <span>{baseRef}</span>
        <span>→</span>
        <span>{targetRef}</span>
        <InfoCircleOutlined />
      </summary>
      <div className="diffBranchPopover">
        <strong>Diff 审查范围</strong>
        <p>
          {localBaselineActive
            ? "沙箱 Diff 对比的是浏览器建立的轻量文件基线与当前沙箱文件；缺少基线的文件只展示当前快照，不伪装成完整 Git diff。"
            : context?.explanation ?? "右侧 Diff 展示当前会话产生的文件变更；这里用于说明审查范围，不会切换 Git 分支。"}
        </p>
        {showSandboxContext && sandboxState && (
          <dl>
            <div>
              <dt>基线文件</dt>
              <dd>{sandboxState.fileCount}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>{sandboxStateLabel(sandboxState)}</dd>
            </div>
          </dl>
        )}
        {showProjectContext && context && (
          <dl>
            <div>
              <dt>项目</dt>
              <dd>{context.projectName}</dd>
            </div>
            <div>
              <dt>基准分支</dt>
              <dd>{baseRef}</dd>
            </div>
            {context.githubUrl && (
              <div>
                <dt>仓库</dt>
                <dd>
                  <a href={context.githubUrl} target="_blank" rel="noreferrer">
                    打开 GitHub
                  </a>
                </dd>
              </div>
            )}
          </dl>
        )}
        <small>{localBaselineActive || !context?.canChangeBase ? "当前只读说明审查范围，不执行分支切换。" : "可以切换审查基准。"}</small>
      </div>
    </details>
  );
}

function DiffFileStatus({
  change,
  applyStatus,
  applying,
  onApply,
  onOpenFile,
  onRefreshSandboxFile,
  onSetSandboxBaseline,
}: {
  change: HubFileChangeDto;
  applyStatus: ReturnType<typeof fileChangeApplyStatus>;
  applying: boolean;
  onApply?: (change: HubFileChangeDto) => void;
  onOpenFile?: (path: string) => void;
  onRefreshSandboxFile?: (change: HubFileChangeDto) => void;
  onSetSandboxBaseline?: (change: HubFileChangeDto) => void;
}) {
  const applyMessage = fileChangeApplyMessage(change);
  const applyLocked = applyStatus === "queued" || applyStatus === "applied";
  const sandboxChange = isSandboxObservedChange(change);
  const draftChange = isFilesystemDraftChange(change);
  const localChange = sandboxChange || draftChange;
  const showApplyButton = onApply && !applyLocked && !localChange;
  return (
    <div className="diffReviewFileMeta">
      <span className={`diffSource ${localChange ? "local" : "backend"}`}>{sandboxDiffLabel(change)}</span>
      <span className={`changeType ${change.changeType}`}>{fileChangeTypeLabel(change.changeType)}</span>
      {applyStatus && <span className={`applyStatus ${applyStatus}`}>{fileChangeApplyLabel(applyStatus)}</span>}
      {showApplyButton && (
        <button
          className="diffApplyInlineButton"
          type="button"
          disabled={applying}
          onClick={() => onApply(change)}
        >
          <CheckCircleOutlined />
          <span>{applying ? "应用中" : "应用"}</span>
        </button>
      )}
      {onOpenFile && localChange && (
        <button className="diffApplyInlineButton" type="button" onClick={() => onOpenFile(change.path)}>
          <FileOutlined />
          <span>打开文件</span>
        </button>
      )}
      {sandboxChange && onRefreshSandboxFile && (
        <button className="diffApplyInlineButton" type="button" onClick={() => onRefreshSandboxFile(change)}>
          <ReloadOutlined />
          <span>刷新</span>
        </button>
      )}
      {sandboxChange && onSetSandboxBaseline && (
        <button className="diffApplyInlineButton" type="button" onClick={() => onSetSandboxBaseline(change)}>
          <CheckCircleOutlined />
          <span>设为基线</span>
        </button>
      )}
      {change.afterTruncated || change.beforeTruncated ? <span className="diffMetaNote">已截断</span> : null}
      {applyMessage ? <span className={`diffApplyMessage ${applyStatus ?? ""}`}>{applyMessage}</span> : null}
    </div>
  );
}

function fileChangeTypeLabel(type: HubFileChangeDto["changeType"]) {
  if (type === "added") return "新增";
  if (type === "deleted") return "删除";
  if (type === "renamed") return "重命名";
  return "修改";
}

function diffEmptyText(state?: SandboxDiffSessionState, disabledReason?: string) {
  if (disabledReason) return disabledReason;
  if (!state) return "沙箱 Diff 监听尚未启动";
  if (state.status === "connecting") return "正在连接沙箱 Diff 监听";
  if (state.status === "baselining") return "正在建立浏览器观测基线";
  if (state.status === "ready") return "当前基线后暂无文件变更";
  if (state.status === "unavailable") return state.error ? `沙箱 Diff 不可用：${state.error}` : "沙箱 Diff 不可用";
  if (state.status === "error") return state.error ? `沙箱 Diff 读取失败：${state.error}` : "沙箱 Diff 读取失败";
  return "暂无文件变更";
}

function sandboxStateLabel(state: SandboxDiffSessionState) {
  if (state.status === "ready") return "已建立";
  if (state.status === "baselining") return "建立中";
  if (state.status === "connecting") return "连接中";
  if (state.status === "unavailable") return "不可用";
  if (state.status === "error") return "读取失败";
  return "空闲";
}

function DiffFileDetails({
  change,
  expanded,
}: {
  change: HubFileChangeDto;
  expanded: boolean;
}) {
  return (
    <section className={`diffViewerCard ${expanded ? "expanded" : "collapsed"}`} hidden={!expanded}>
      {change.metadata?.baselineAvailable === false && (
        <div className="diffSnapshotNotice">
          缺少浏览器基线，仅展示当前文件快照；这里不统计新增/删除行。
        </div>
      )}
      <UnifiedDiffView change={change} />
    </section>
  );
}

type OpenedSandboxFile = {
  path: string;
  size?: number | null;
  mtime?: string | null;
  version?: string | null;
};

type SandboxPreviewKind = "html" | "markdown" | "image" | "pdf" | "docx" | "unsupported" | null;

export function FilePanel({
  sessionId,
  disabledReason,
  openRequest,
  onSaved,
  onNotice,
  onFileOpened,
  onFileContentLoaded,
  onDraftChanged,
}: {
  sessionId?: string | null;
  disabledReason?: string;
  openRequest?: { path: string; nonce: number } | null;
  onSaved?: () => void;
  onNotice?: (message: string) => void;
  onFileOpened?: (path: string) => void;
  onFileContentLoaded?: (path: string, content: string) => void;
  onDraftChanged?: (path: string, beforeContent: string, afterContent: string, language?: string | null) => void;
}) {
  const clientRef = useRef<SandboxFilesystemClient | null>(null);
  const currentPathRef = useRef("");
  const fileRef = useRef<FilesystemReadFileDto | null>(null);
  const draftRef = useRef("");
  const [connection, setConnection] = useState<SandboxFilesystemConnectionResponse | null>(null);
  const [branch, setBranch] = useState("");
  const [branchDraft, setBranchDraft] = useState("");
  const [socketState, setSocketState] = useState<"connecting" | "connected" | "disconnected" | "unavailable">("disconnected");
  const [currentPath, setCurrentPath] = useState("");
  const [treeItems, setTreeItems] = useState<FilesystemEntryDto[]>([]);
  const [openedFile, setOpenedFile] = useState<OpenedSandboxFile | null>(null);
  const [file, setFile] = useState<FilesystemReadFileDto | null>(null);
  const [draft, setDraft] = useState("");
  const [loadingConnection, setLoadingConnection] = useState(false);
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [error, setError] = useState("");

  const canUseSandbox = Boolean(sessionId && !disabledReason && connection);
  const dirty = Boolean(file && draft !== file.content);
  const branchLabel = branch || "main";

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setConnection(null);
    setBranch("");
    setBranchDraft("");
    setSocketState("disconnected");
    setCurrentPath("");
    setTreeItems([]);
    setOpenedFile(null);
    setFile(null);
    setDraft("");
    setPreviewMode(false);
    setError("");
    setLoadingConnection(false);
    setLoadingTree(false);
    setLoadingFile(false);
    setSaving(false);
    if (!sessionId || disabledReason) return;

    let cancelled = false;
    setLoadingConnection(true);
    void getSandboxFilesystemConnection(sessionId).then((result) => {
      if (cancelled) return;
      setLoadingConnection(false);
      if (!result.ok) {
        setError(`沙箱文件视图尚未就绪：${result.error}`);
        return;
      }
      setConnection(result.data);
      setError("");
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId, disabledReason]);

  useEffect(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setCurrentPath("");
    setTreeItems([]);
    setOpenedFile(null);
    setFile(null);
    setDraft("");
    setPreviewMode(false);
    if (!connection || disabledReason) return;

    const client = connectSandboxFilesystemSocket(connection, {
      branch: branch.trim() || undefined,
      onState: setSocketState,
      onChanged: (event) => handleFilesystemChanged(event.path),
    });
    clientRef.current = client;
    void loadTree(client, "");

    return () => {
      client.disconnect();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [connection?.downstreamSessionId, branch, disabledReason]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || socketState !== "connected" || !openRequest?.path) return;
    void openSandboxFile({ path: openRequest.path });
  }, [openRequest?.nonce, socketState]);

  function handleFilesystemChanged(changedPath: string) {
    const client = clientRef.current;
    if (!client) return;
    void loadTree(client, currentPathRef.current);
    const openedFile = fileRef.current;
    if (openedFile && openedFile.path === changedPath && draftRef.current === openedFile.content) {
      void readFile(client, openedFile.path, { silent: true });
    }
  }

  async function loadTree(client: SandboxFilesystemClient, path: string) {
    setLoadingTree(true);
    const nextPath = normalizeDirectoryPath(path);
    const result = await client.list(nextPath || ".", 1);
    setLoadingTree(false);
    if (!result.ok) {
      setError(`文件列表加载失败：${result.error}`);
      return;
    }
    setCurrentPath(nextPath);
    setTreeItems(sortFilesystemEntries(result.data.entries));
    setError("");
  }

  async function openDirectory(path: string) {
    const client = clientRef.current;
    if (!client) return;
    await loadTree(client, path);
  }

  async function openFile(path: string) {
    const item = treeItems.find((entry) => entry.kind === "file" && entry.path === path);
    await openSandboxFile({ path, size: item?.size, mtime: item?.mtime, version: item?.version });
  }

  async function openSandboxFile(target: OpenedSandboxFile) {
    const client = clientRef.current;
    if (!client) return;
    onFileOpened?.(target.path);
    setOpenedFile(target);
    setError("");

    const editable = isTextEditableFile(target.path);
    const kind = previewKindFromPath(target.path);
    setPreviewMode(!editable && Boolean(kind));

    if (!editable) {
      setFile(null);
      setDraft("");
      return;
    }

    await readFile(client, target.path);
  }

  async function readFile(client: SandboxFilesystemClient, path: string, options: { silent?: boolean } = {}) {
    if (!options.silent) {
      setLoadingFile(true);
    }
    const result = await client.read(path, 0, 0);
    if (!options.silent) setLoadingFile(false);
    if (!result.ok) {
      setError(`文件读取失败：${result.error}`);
      return;
    }
    setOpenedFile({
      path: result.data.path,
      size: result.data.size,
      mtime: result.data.mtime,
      version: result.data.version,
    });
    setFile(result.data);
    setDraft(result.data.content);
    if (!options.silent) setPreviewMode(false);
    onFileContentLoaded?.(result.data.path, result.data.content);
    setError("");
  }

  async function saveFile() {
    const client = clientRef.current;
    if (!sessionId || !client || !file || saving) return;
    const edits = buildTextEdits(file.content, draft);
    if (edits.length === 0) return;
    setSaving(true);
    const result = await client.update({
      path: file.path,
      expectedVersion: file.version,
      edits,
    });
    setSaving(false);
    if (!result.ok) {
      setError(`保存失败：${result.error}`);
      return;
    }
    const nextFile = {
      path: result.data.path,
      content: draft,
      size: result.data.size,
      mtime: result.data.mtime,
      version: result.data.version,
    };
    setFile(nextFile);
    setOpenedFile(nextFile);
    setDraft(nextFile.content);
    onDraftChanged?.(nextFile.path, nextFile.content, nextFile.content, languageFromPath(nextFile.path));
    setError("");
    onNotice?.(`已保存到 ${result.data.branchName ?? branchLabel}`);
    onSaved?.();
    void loadTree(client, currentPath);
  }

  function handleBranchChange(nextBranch: string) {
    const normalized = nextBranch.trim();
    if (normalized === branch) return;
    if (dirty && !window.confirm("当前文件未保存，切换分支会丢弃编辑，是否继续？")) {
      setBranchDraft(branch);
      return;
    }
    setBranch(normalized);
    setBranchDraft(normalized);
    setError("");
  }

  const parentPath = currentPath.includes("/") ? currentPath.split("/").slice(0, -1).join("/") : "";
  const fileName = openedFile ? fileNameFromPath(openedFile.path) : "";
  const fileLanguage = openedFile ? languageFromPath(openedFile.path) : "text";
  const previewKind = openedFile ? previewKindFromPath(openedFile.path) : null;
  const canPreview = Boolean(previewKind && openedFile);
  const canEdit = Boolean(file);
  const previewUrl = connection && openedFile ? sandboxPreviewUrl(connection.downstreamSessionId, openedFile.path) : "";
  const previewDirUrl = connection && openedFile ? sandboxPreviewBaseUrl(connection.downstreamSessionId, openedFile.path) : "";
  const previewRootUrl = connection ? sandboxPreviewRootUrl(connection.downstreamSessionId) : "";
  const htmlPreview = previewKind === "html" ? htmlWithPreviewBase(draft, previewDirUrl, previewRootUrl) : "";
  const statusSize = file?.size ?? openedFile?.size ?? 0;

  return (
    <div className={`panelScroll filePanel ${openedFile ? "hasFile" : ""}`}>
      {disabledReason ? (
        <PanelEmpty icon={<FileOutlined />} text={disabledReason} />
      ) : (
        <div className="fileWorkspace">
          <section className="fileExplorerPane" aria-label="沙箱文件资源管理器">
            <div className="fileExplorerHeader">
              <div>
                <strong><FolderOpenOutlined /> 资源管理器</strong>
              </div>
              <button
                type="button"
                title="刷新文件列表"
                disabled={!canUseSandbox || loadingTree || socketState !== "connected"}
                onClick={() => clientRef.current && void loadTree(clientRef.current, currentPath)}
              >
                <ReloadOutlined />
              </button>
            </div>

            {error && <div className="filePanelNotice">{error}</div>}

            <section className="fileBrowser" aria-label="沙箱文件列表">
              <div className="fileBrowserTop">
                {currentPath && (
                  <button type="button" onClick={() => void openDirectory(parentPath)}>
                    返回上级
                  </button>
                )}
              </div>
              <div className="fileTreeList">
                {loadingConnection || socketState === "connecting" ? (
                  <span className="fileMuted">正在连接沙箱...</span>
                ) : loadingTree ? (
                  <span className="fileMuted">正在加载文件...</span>
                ) : treeItems.length === 0 ? (
                  <span className="fileMuted">暂无文件</span>
                ) : (
                  treeItems.map((item) => (
                    <button
                      className={`fileTreeItem ${item.kind === "dir" ? "directory" : "file"} ${openedFile?.path === item.path ? "active" : ""}`}
                      type="button"
                      title={item.path}
                      key={`${item.kind}:${item.path}`}
                      onClick={() => (item.kind === "dir" ? void openDirectory(item.path) : void openFile(item.path))}
                    >
                      {item.kind === "dir" ? <RightOutlined /> : <FileOutlined />}
                      <span>{item.name}</span>
                      {item.kind === "file" && item.size != null ? <small>{formatBytes(item.size)}</small> : null}
                    </button>
                  ))
                )}
              </div>
            </section>
          </section>

          <section className={`fileEditorPane ${previewMode ? "previewMode" : "editMode"}`} aria-label="沙箱文件编辑器">
            <div className="fileEditorTabs">
              <div className={`fileEditorTab ${openedFile && !previewMode ? "active" : "empty"}`}>
                <button className="fileTabButton" type="button" disabled={!canEdit} onClick={() => setPreviewMode(false)}>
                  {openedFile ? <FileOutlined /> : <CodeOutlined />}
                  <span title={openedFile?.path ?? ""}>{openedFile ? fileName : "未打开文件"}</span>
                  {dirty && <small>未保存</small>}
                </button>
              </div>
              {canPreview && !previewMode && (
                <button className="filePreviewButton" type="button" onClick={() => setPreviewMode(true)}>
                  <EyeOutlined />
                  <span>预览</span>
                </button>
              )}
              {previewMode && (
                <button className="filePreviewButton active" type="button" disabled={!canEdit} onClick={() => setPreviewMode(false)}>
                  <EditOutlined />
                  <span>编辑</span>
                </button>
              )}
              {!previewMode && (
                <button className="fileSaveButton" type="button" disabled={!dirty || saving || loadingFile} onClick={() => void saveFile()}>
                  <SaveOutlined />
                  <span>{saving ? "保存中" : "保存"}</span>
                </button>
              )}
            </div>
            {openedFile && !previewMode && (
            <div className="fileEditorPathBar">
              <span title={openedFile.path}>{openedFile.path}</span>
              {loadingFile && <small>正在读取...</small>}
            </div>
            )}
            {file && !previewMode && (
              <textarea
                spellCheck={false}
                value={draft}
                placeholder={loadingFile ? "正在读取文件..." : ""}
                disabled={loadingFile}
                onChange={(event) => {
                  const next = event.target.value;
                  setDraft(next);
                  if (file) onDraftChanged?.(file.path, file.content, next, fileLanguage);
                }}
              />
            )}
            {openedFile && !file && !previewMode && (
              <div className="filePreviewPlaceholder">
                <p>该类型仅支持预览，不能直接编辑。</p>
                {previewUrl && (
                  <a href={previewUrl} target="_blank" rel="noreferrer">
                    打开原文件
                  </a>
                )}
              </div>
            )}
            {openedFile && previewMode && previewKind && (
              <div className="filePreviewPane">
                {previewKind === "html" && (
                  <iframe key={`preview-${openedFile.path}`} className="filePreviewFrame" title={fileName} srcDoc={file?.content ?? draft} sandbox="" />
                )}
                {previewKind === "markdown" && (
                  <div className="filePreviewMarkdown"><RichText text={draft} /></div>
                )}
                {previewKind === "image" && (
                  <div className="filePreviewImage"><img alt={fileName} src={previewUrl} /></div>
                )}
                {previewKind === "pdf" && (
                  <iframe className="filePreviewFrame" title={fileName} src={previewUrl} />
                )}
                {previewKind === "docx" && (
                  <DocxSandboxPreview title={fileName} url={previewUrl} />
                )}
                {previewKind === "unsupported" && (
                  <div className="filePreviewPlaceholder">
                    <p>当前类型暂不支持内嵌预览。</p>
                    {previewUrl && (
                      <a href={previewUrl} target="_blank" rel="noreferrer">
                        打开原文件
                      </a>
                    )}
                  </div>
                )}
              </div>
            )}
            {!previewMode && (
              <footer className="fileEditorStatus">
                <span>{openedFile ? fileLanguage : "No file"}</span>
                <span>{file ? `${draft.length} 字符 · ${formatBytes(statusSize)}` : openedFile ? formatBytes(statusSize) : "Ready"}</span>
                <span>{dirty ? "已修改" : file ? "已同步" : openedFile ? "仅预览" : "空闲"}</span>
              </footer>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export function ArtifactPanel({
  artifacts,
  onUseSelection,
  onUseDraft,
}: {
  artifacts: HubArtifactDto[];
  onUseSelection?: (artifact: HubArtifactDto, selectedText: string) => void;
  onUseDraft?: (artifact: HubArtifactDto, editedText: string) => void;
}) {
  const [activeArtifact, setActiveArtifact] = useState<HubArtifactDto | null>(null);

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
            <div className="artifactActions">
              <button
                title="展开预览"
                type="button"
                onClick={() => {
                  setActiveArtifact(artifact);
                }}
              >
                <ExpandOutlined />
              </button>
              <a title="打开内容" href={artifactContentUrl(artifact.id)} target="_blank" rel="noreferrer">
                <LinkOutlined />
              </a>
            </div>
          </div>
          <ArtifactPreview artifact={artifact} />
        </article>
      ))}
      {activeArtifact && (
        <ArtifactViewerLayer
          artifact={activeArtifact}
          onClose={() => setActiveArtifact(null)}
          onUseSelection={onUseSelection}
          onUseDraft={onUseDraft}
        />
      )}
    </div>
  );
}

export function ArtifactViewerLayer({
  artifact,
  onClose,
  onUseSelection,
  onUseDraft,
}: {
  artifact: HubArtifactDto;
  onClose: () => void;
  onUseSelection?: (artifact: HubArtifactDto, selectedText: string) => void;
  onUseDraft?: (artifact: HubArtifactDto, editedText: string) => void;
}) {
  const [viewerMode, setViewerMode] = useState<"preview" | "code">("preview");
  const [selectedText, setSelectedText] = useState("");
  const [draftText, setDraftText] = useState("");
  const [versions, setVersions] = useState<HubArtifactVersionDto[]>([]);
  const [activeVersion, setActiveVersion] = useState<HubArtifactVersionDto | null>(null);

  useEffect(() => {
    setViewerMode("preview");
    setSelectedText("");
    setActiveVersion(null);
    setVersions([]);
  }, [artifact.id]);

  useEffect(() => {
    let cancelled = false;
    void listArtifactVersions(artifact.id).then((result) => {
      if (cancelled) return;
      if (result.ok) setVersions(result.data.items);
      else setVersions([]);
    });
    return () => {
      cancelled = true;
    };
  }, [artifact.id]);

  const displayedArtifact = activeVersion ? artifactFromVersion(artifact, activeVersion) : artifact;
  const sourceText = displayedArtifact.textContent ?? "";
  const draftChanged = draftText !== sourceText;

  useEffect(() => {
    setDraftText(displayedArtifact.textContent ?? "");
  }, [displayedArtifact.id, displayedArtifact.version, displayedArtifact.textContent]);

  return (
    <div className="artifactViewerLayer" role="presentation" onMouseDown={onClose}>
      <section
        className="artifactViewer"
        role="dialog"
        aria-modal="true"
        aria-label={artifact.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>{displayedArtifact.title}</strong>
            <span>{displayedArtifact.kind} · {displayedArtifact.mimeType} · v{displayedArtifact.version}</span>
          </div>
          <div className="artifactViewerActions">
            <button
              className={viewerMode === "preview" ? "active" : ""}
              type="button"
              onClick={() => setViewerMode("preview")}
            >
              <FileDoneOutlined />
              <span>预览</span>
            </button>
            <button
              className={viewerMode === "code" ? "active" : ""}
              type="button"
              disabled={!displayedArtifact.textContent}
              onClick={() => setViewerMode("code")}
            >
              <CodeOutlined />
              <span>代码</span>
            </button>
            <a href={artifactContentUrl(artifact.id)} target="_blank" rel="noreferrer">
              <LinkOutlined />
            </a>
            <button type="button" title="关闭" onClick={onClose}>
              ×
            </button>
          </div>
        </header>
        {versions.length > 0 && (
          <div className="artifactVersionBar">
            <span>版本历史</span>
            <button className={!activeVersion ? "active" : ""} type="button" onClick={() => setActiveVersion(null)}>
              当前 v{artifact.version}
            </button>
            {versions.map((version) => (
              <button
                className={activeVersion?.id === version.id ? "active" : ""}
                key={version.id}
                type="button"
                onClick={() => {
                  setActiveVersion(version);
                  setSelectedText("");
                }}
              >
                v{version.version}
              </button>
            ))}
          </div>
        )}
        <div className="artifactViewerBody">
          {viewerMode === "code" && displayedArtifact.textContent ? (
            <div className="artifactCodeEditor">
              <textarea
                spellCheck={false}
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                onSelect={(event) =>
                  setSelectedText(
                    event.currentTarget.value.slice(event.currentTarget.selectionStart, event.currentTarget.selectionEnd),
                  )
                }
              />
              <div className="artifactCodeBar">
                <button type="button" disabled={!draftChanged} onClick={() => setDraftText(sourceText)}>
                  <span>重置</span>
                </button>
                <button type="button" onClick={() => void navigator.clipboard?.writeText(draftText)}>
                  <CopyOutlined />
                  <span>复制全部</span>
                </button>
                {onUseSelection && (
                  <button
                    type="button"
                    disabled={!selectedText.trim()}
                    onClick={() => {
                      onUseSelection(displayedArtifact, selectedText.trim());
                      onClose();
                    }}
                  >
                    <SelectOutlined />
                    <span>引用选区</span>
                  </button>
                )}
                {onUseDraft && (
                  <button
                    type="button"
                    disabled={!draftChanged || !draftText.trim()}
                    onClick={() => {
                      onUseDraft(displayedArtifact, draftText.trim());
                      onClose();
                    }}
                  >
                    <SelectOutlined />
                    <span>引用修改继续对话</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <ArtifactPreview artifact={displayedArtifact} expanded />
          )}
        </div>
      </section>
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

function ArtifactPreview({ artifact, expanded = false }: { artifact: HubArtifactDto; expanded?: boolean }) {
  const contentUrl = artifactContentUrl(artifact.id);
  if (artifact.kind === "image") {
    return (
      <div className={`mediaPreview ${expanded ? "expanded" : ""}`}>
        <img alt={artifact.title} src={contentUrl} />
      </div>
    );
  }

  if (artifact.kind === "pdf") {
    return <iframe className={`documentFrame ${expanded ? "expanded" : ""}`} title={artifact.title} src={contentUrl} />;
  }

  if (artifact.kind === "html" && artifact.textContent) {
    return <iframe className={`documentFrame ${expanded ? "expanded" : ""}`} title={artifact.title} srcDoc={artifact.textContent} sandbox="" />;
  }

  if (artifact.kind === "html") {
    return <iframe className={`documentFrame ${expanded ? "expanded" : ""}`} title={artifact.title} src={contentUrl} sandbox="" />;
  }

  if (artifact.kind === "docx") {
    const publicUrl = publicArtifactUrlFromArtifact(artifact);
    const officeUrl = publicUrl ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(publicUrl)}` : null;
    if (officeUrl) {
      return <iframe className={`documentFrame ${expanded ? "expanded" : ""}`} title={artifact.title} src={officeUrl} />;
    }
    return <DocumentFallback title="DOCX 原始文件" text="当前文件没有可供在线渲染的公开 URL，可打开原文件查看。" />;
  }

  if (artifact.kind === "pptx") {
    return <PptxPreview artifact={artifact} contentUrl={contentUrl} expanded={expanded} />;
  }

  if (artifact.textContent) {
    return artifact.kind === "log" ? <pre>{artifact.textContent}</pre> : <RichText text={artifact.textContent} />;
  }

  if (artifact.storageUri) return <code>{artifact.storageUri}</code>;

  return <DocumentFallback title="暂无可预览内容" text="下游尚未提供文本、公开 URL 或可渲染 metadata。" />;
}

function PptxPreview({
  artifact,
  contentUrl,
  expanded,
}: {
  artifact: HubArtifactDto;
  contentUrl: string;
  expanded: boolean;
}) {
  const slides = pptSlidesFromMetadata(artifact.metadata);
  const [index, setIndex] = useState(0);
  const current = slides[index] ?? null;
  const publicUrl = publicArtifactUrlFromArtifact(artifact);
  const officeUrl = publicUrl ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(publicUrl)}` : null;

  if (slides.length > 0 && current) {
    return (
      <div className={`pptxPreview ${expanded ? "expanded" : ""}`}>
        <div className="pptxSlide">
          {current.imageUrl && <img alt={current.title || `Slide ${index + 1}`} src={current.imageUrl} />}
          <div>
            <span>Slide {index + 1} / {slides.length}</span>
            <strong>{current.title || `Slide ${index + 1}`}</strong>
            {current.text && <p>{current.text}</p>}
          </div>
        </div>
        <div className="pptxControls">
          <button type="button" disabled={index === 0} onClick={() => setIndex((value) => Math.max(0, value - 1))}>
            上一页
          </button>
          <button type="button" disabled={index >= slides.length - 1} onClick={() => setIndex((value) => Math.min(slides.length - 1, value + 1))}>
            下一页
          </button>
        </div>
      </div>
    );
  }

  if (officeUrl) {
    return <iframe className={`documentFrame ${expanded ? "expanded" : ""}`} title={artifact.title} src={officeUrl} />;
  }

  return (
    <div className="documentFallback">
      <FileDoneOutlined />
      <div>
        <strong>PPTX 原始文件</strong>
        <span>可打开原文件；下游若提供 metadata.slides，将在这里按页浏览。</span>
      </div>
    </div>
  );
}

function DocumentFallback({ title, text }: { title: string; text: string }) {
  return (
    <div className="documentFallback">
      <FileDoneOutlined />
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}

function UnifiedDiffView({ change }: { change: HubFileChangeDto }) {
  const lines = buildDiffLines(change).filter((line) => line.kind !== "meta");
  return <UnifiedDiffLines lines={lines} />;
}

function UnifiedDiffLines({ lines, variant = "review" }: { lines: DiffLine[]; variant?: "review" | "git" }) {
  const [collapsedHunks, setCollapsedHunks] = useState<Set<string>>(() => new Set());
  const items = groupDiffLines(lines);

  function toggleHunk(id: string) {
    setCollapsedHunks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="unifiedDiff" role="table">
      {items.map((item) => {
        if (item.kind === "line") {
          return renderDiffLine(item.line, item.index, variant);
        }

        const collapsed = collapsedHunks.has(item.id);
        const hunkContextTitle = diffHunkContextTitle(item);
        return (
          <div className={`diffHunk ${collapsed ? "collapsed" : ""}`} key={item.id}>
            <div className="diffLine meta hunkMeta diffHunkHeader" role="row">
              <button
                className="diffHunkToggle"
                type="button"
                title={`${collapsed ? "展开代码段" : "收起代码段"}，${hunkContextTitle}`}
                aria-label={`${collapsed ? "展开代码段" : "收起代码段"}，${hunkContextTitle}`}
                aria-expanded={!collapsed}
                onClick={() => toggleHunk(item.id)}
              >
                {collapsed ? <RightOutlined /> : <DownOutlined />}
              </button>
              <code title={`${diffMetaLabel(item.meta.text)} · ${hunkContextTitle}`}>{item.foldLabel}</code>
            </div>
            {!collapsed && item.lines.map(({ line, index }) => renderDiffLine(line, index, variant))}
          </div>
        );
      })}
    </div>
  );
}

function renderDiffLine(line: DiffLine, index: number, variant: "review" | "git" = "review") {
  if (line.kind === "meta") {
    return (
      <div className="diffLine meta fileMeta" key={`${index}-${line.text}`} role="row">
        <span className="diffHunkToggle spacer" aria-hidden="true" />
        <code>{diffMetaLabel(line.text)}</code>
      </div>
    );
  }

  if (variant === "git") {
    const visibleLineNumber = line.kind === "remove" ? line.oldLine : (line.newLine ?? line.oldLine);
    return (
      <div className={`diffLine singleLineNumber ${line.kind}`} key={`${index}-${line.oldLine ?? "x"}-${line.newLine ?? "x"}`} role="row">
        <span className="lineNo">{visibleLineNumber ?? ""}</span>
        <span className="lineMarker">{diffMarker(line.kind)}</span>
        <code>{line.text || " "}</code>
      </div>
    );
  }

  return (
    <div className={`diffLine ${line.kind}`} key={`${index}-${line.oldLine ?? "x"}-${line.newLine ?? "x"}`} role="row">
      <span className="lineNo">{line.oldLine ?? ""}</span>
      <span className="lineNo">{line.newLine ?? ""}</span>
      <span className="lineMarker">{diffMarker(line.kind)}</span>
      <code>{line.text || " "}</code>
    </div>
  );
}

type DiffRenderItem =
  | { kind: "line"; line: DiffLine; index: number }
  | {
      kind: "hunk";
      id: string;
      meta: DiffLine;
      foldLabel: string;
      lines: Array<{ line: DiffLine; index: number }>;
    };

function groupDiffLines(lines: DiffLine[]): DiffRenderItem[] {
  const items: DiffRenderItem[] = [];
  let activeHunk: Extract<DiffRenderItem, { kind: "hunk" }> | null = null;
  let previousOldEnd = 0;
  let previousNewEnd = 0;

  lines.forEach((line, index) => {
    if (line.kind === "meta" && line.text.startsWith("@@")) {
      const range = parseHunkRange(line.text);
      const unchangedBefore = range
        ? Math.max(0, Math.max(range.oldStart - previousOldEnd - 1, range.newStart - previousNewEnd - 1))
        : 0;
      activeHunk = {
        kind: "hunk",
        id: `${index}-${line.text}`,
        meta: line,
        foldLabel: `${unchangedBefore} unmodified ${unchangedBefore === 1 ? "line" : "lines"}`,
        lines: [],
      };
      if (range) {
        previousOldEnd = range.oldStart + range.oldLines - 1;
        previousNewEnd = range.newStart + range.newLines - 1;
      }
      items.push(activeHunk);
      return;
    }

    if (activeHunk && line.kind !== "meta") {
      activeHunk.lines.push({ line, index });
      return;
    }

    items.push({ kind: "line", line, index });
  });

  return items;
}

function parseHunkRange(text: string) {
  const match = text.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function diffHunkContextTitle(item: Extract<DiffRenderItem, { kind: "hunk" }>) {
  const unchanged = item.lines.filter(({ line }) => line.kind === "context").length;
  return unchanged > 0 ? `${unchanged} 行上下文` : "仅包含变更行";
}

function diffMetaLabel(text: string) {
  if (text.startsWith("@@")) return text;
  if (text.startsWith("diff --git")) return text.replace(/^diff --git\s+/, "");
  return text;
}

function sameStringSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function normalizeDirectoryPath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function previewKindFromPath(path: string): SandboxPreviewKind {
  const ext = fileExtFromPath(path);
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (["doc", "ppt", "pptx"].includes(ext)) return "unsupported";
  return null;
}

function isTextEditableFile(path: string) {
  const name = fileNameFromPath(path).toLowerCase();
  if (TEXT_EDITABLE_FILENAMES.has(name)) return true;
  const ext = fileExtFromPath(path);
  return Boolean(ext && TEXT_EDITABLE_EXTENSIONS.has(ext));
}

const TEXT_EDITABLE_FILENAMES = new Set([
  ".dockerignore",
  ".env",
  ".env.example",
  ".eslintignore",
  ".eslintrc",
  ".gitignore",
  ".npmrc",
  ".prettierignore",
  ".prettierrc",
  "dockerfile",
  "license",
  "makefile",
  "readme",
]);

const TEXT_EDITABLE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "svg",
  "yml",
  "yaml",
  "toml",
  "ini",
  "env",
  "sh",
  "bash",
  "ps1",
  "py",
  "java",
  "go",
  "rs",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "rb",
  "sql",
  "prisma",
  "log",
  "gitignore",
]);

function fileExtFromPath(path: string) {
  const fileName = fileNameFromPath(path);
  return fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() ?? "" : "";
}

function sandboxPreviewUrl(downstreamSessionId: string, path: string) {
  const normalizedPath = normalizeFilePath(path);
  return `/filesystem/preview/${encodeURIComponent(downstreamSessionId)}/${encodePathSegments(normalizedPath)}`;
}

function sandboxPreviewBaseUrl(downstreamSessionId: string, path: string) {
  const normalizedPath = normalizeFilePath(path);
  const dir = normalizedPath.includes("/") ? normalizedPath.split("/").slice(0, -1).join("/") : "";
  const base = sandboxPreviewRootUrl(downstreamSessionId);
  return dir ? `${base}${encodePathSegments(dir)}/` : base;
}

function sandboxPreviewRootUrl(downstreamSessionId: string) {
  return `/filesystem/preview/${encodeURIComponent(downstreamSessionId)}/`;
}

function encodePathSegments(path: string) {
  return normalizeFilePath(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function normalizeFilePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/g, "");
}

function htmlWithPreviewBase(html: string, baseUrl: string, rootUrl: string) {
  if (!baseUrl) return html;
  const baseTag = `<base href="${escapeHtmlAttribute(baseUrl)}">`;
  const withBase = /<base\s/i.test(html)
    ? html.replace(/<base\b[^>]*>/i, baseTag)
    : /<head\b[^>]*>/i.test(html)
      ? html.replace(/<head\b([^>]*)>/i, `<head$1>${baseTag}`)
      : `${baseTag}${html}`;
  if (!rootUrl) return withBase;
  const escapedRoot = escapeHtmlAttribute(rootUrl);
  return withBase.replace(/\b(src|href)=("|')\/(?!\/)([^"']*)\2/gi, (_match, attr: string, quote: string, path: string) => {
    return `${attr}=${quote}${escapedRoot}${path}${quote}`;
  });
}

function escapeHtmlAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function DocxSandboxPreview({ title, url }: { title: string; url: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container || !url) return;
    container.innerHTML = "";
    setState("loading");

    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        container.innerHTML = "";
        await renderAsync(data, container, undefined, {
          className: "sandboxDocx",
          inWrapper: true,
          ignoreWidth: true,
          ignoreHeight: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });
        if (!cancelled) setState("ready");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="filePreviewDocx" aria-label={title}>
      {state === "loading" && <div className="filePreviewPlaceholder"><p>正在渲染 Word 文档...</p></div>}
      {state === "failed" && (
        <div className="filePreviewPlaceholder">
          <p>Word 文档预览失败。</p>
          <a href={url} target="_blank" rel="noreferrer">
            打开原文件
          </a>
        </div>
      )}
      <div className="filePreviewDocxBody" ref={containerRef} hidden={state !== "ready"} />
    </div>
  );
}

function socketStateLabel(state: "connecting" | "connected" | "disconnected" | "unavailable") {
  if (state === "connected") return "已连接";
  if (state === "connecting") return "连接中";
  if (state === "unavailable") return "不可用";
  return "已断开";
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

function artifactFromVersion(artifact: HubArtifactDto, version: HubArtifactVersionDto): HubArtifactDto {
  return {
    ...artifact,
    title: version.title,
    kind: version.kind,
    mimeType: version.mimeType,
    storageKind: version.storageKind,
    storageUri: version.storageUri,
    textContent: version.textContent,
    sha256: version.sha256,
    sizeBytes: version.sizeBytes,
    version: version.version,
    final: version.final,
    metadata: version.metadata,
    createdAt: version.createdAt,
  };
}
