import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import type {
  AnnotationSide,
  DiffLineAnnotation,
  OnDiffLineClickProps,
  SelectedLineRange,
} from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/types";
import type {
  EnvironmentId,
  ReviewDiffPreviewResult,
  ReviewDiffPreviewSource,
  ThreadId,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  FolderClosedIcon,
  FolderIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  RefreshCwIcon,
  Rows3Icon,
  WandSparklesIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { subscribeEnvironmentConnections } from "~/environments/runtime";
import {
  buildFileDiffRenderKey,
  getDiffCollapseIconClassName,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import type { ReviewCommentContext } from "~/reviewCommentContext";

import type { ReviewRouteSource } from "../../diffRouteSearch";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type DiffRenderMode = "inline" | "split";
type DiffThemeType = "light" | "dark";
type ReviewCommentTargetKind = "file" | "folder" | "line";
type ReviewLinePlacement = "line" | "file-top";
type PreviewStatus = "idle" | "loading" | "success" | "error";
type ReviewFixPending = "selected" | "all" | `comment:${string}`;

export interface ReviewWorkspaceComment {
  readonly id: string;
  readonly targetKind: ReviewCommentTargetKind;
  readonly path: string;
  readonly body: string;
  readonly side?: AnnotationSide | null;
  readonly lineNumber?: number | null;
  readonly placement?: ReviewLinePlacement | null;
  readonly sourceId?: string | null;
  readonly authorLabel?: string | null;
}

export type ReviewWorkspaceTarget =
  | {
      readonly kind: "file";
      readonly path: string;
    }
  | {
      readonly kind: "folder";
      readonly path: string;
    }
  | {
      readonly kind: "line";
      readonly path: string;
      readonly side: AnnotationSide;
      readonly lineNumber: number;
      readonly placement: ReviewLinePlacement;
    };

export interface ReviewWorkspaceCommentDraft {
  readonly sourceId: string;
  readonly sourceKind: ReviewRouteSource;
  readonly sourceTitle: string;
  readonly diffHash: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly target: ReviewWorkspaceTarget;
  readonly body: string;
}

export interface ReviewWorkspaceFixRequest {
  readonly sourceId: string;
  readonly sourceKind: ReviewRouteSource;
  readonly sourceTitle: string;
  readonly diffHash: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly target: ReviewWorkspaceTarget | null;
  readonly viewedFilePaths: ReadonlyArray<string>;
}

export interface ReviewWorkspaceProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly gitCwd: string | null;
  readonly isGitRepo: boolean;
  readonly resolvedTheme: "light" | "dark";
  readonly selectedSource: ReviewRouteSource | undefined;
  readonly selectedBaseRef: string | undefined;
  readonly selectedFilePath: string | undefined;
  readonly onSelectedSourceChange: (
    source: ReviewRouteSource | undefined,
    baseRef?: string | null,
  ) => void;
  readonly onSelectedFilePathChange: (filePath: string | undefined) => void;
  readonly comments?: ReadonlyArray<ReviewWorkspaceComment> | undefined;
  readonly reviewComments?: ReadonlyArray<ReviewCommentContext> | undefined;
  readonly onRunReviewPrompt?: ((prompt: string) => void | Promise<void>) | undefined;
  readonly isRunDisabled?: boolean | undefined;
  readonly onSubmitComment?:
    | ((draft: ReviewWorkspaceCommentDraft) => void | Promise<void>)
    | undefined;
  readonly onResolveComment?: ((commentId: string) => void | Promise<void>) | undefined;
  readonly onFixSelected?:
    | ((request: ReviewWorkspaceFixRequest) => void | Promise<void>)
    | undefined;
  readonly onFixAll?: ((request: ReviewWorkspaceFixRequest) => void | Promise<void>) | undefined;
}

interface PreviewState {
  readonly status: PreviewStatus;
  readonly data: ReviewDiffPreviewResult | null;
  readonly error: string | null;
}

interface ReviewDiffStat {
  additions: number;
  deletions: number;
}

interface ReviewTreeDirectoryNode {
  readonly kind: "directory";
  readonly name: string;
  readonly path: string;
  readonly stat: ReviewDiffStat;
  readonly children: ReviewTreeNode[];
}

interface ReviewTreeFileNode {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly stat: ReviewDiffStat;
}

type ReviewTreeNode = ReviewTreeDirectoryNode | ReviewTreeFileNode;

interface MutableDirectoryNode {
  readonly name: string;
  readonly path: string;
  readonly stat: ReviewDiffStat;
  readonly directories: Map<string, MutableDirectoryNode>;
  readonly files: ReviewTreeFileNode[];
}

interface NormalizedReviewComment {
  readonly id: string;
  readonly targetKind: ReviewCommentTargetKind;
  readonly path: string;
  readonly body: string;
  readonly side: AnnotationSide | null;
  readonly lineNumber: number | null;
  readonly placement: ReviewLinePlacement | null;
  readonly meta: string | null;
}

type ReviewLineAnnotationMetadata =
  | {
      readonly kind: "comment";
      readonly comment: NormalizedReviewComment;
    }
  | {
      readonly kind: "draft";
      readonly target: Extract<ReviewWorkspaceTarget, { readonly kind: "line" }>;
      readonly body: string;
      readonly canSubmit: boolean;
      readonly isSubmitting: boolean;
    };

const REVIEW_DIFF_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: var(--background) !important;
  --diffs-light-bg: var(--background) !important;
  --diffs-dark-bg: var(--background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;
  --diffs-bg-context-override: var(--background);
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 96%, var(--foreground));
  --diffs-bg-buffer-override: var(--background);
  --diffs-addition-base: rgb(36 138 61);
  --diffs-deletion-base: rgb(207 34 46);
  --revex-diff-addition-row-bg: color-mix(in srgb, var(--background) 88%, rgb(36 138 61));
  --revex-diff-addition-row-hover-bg: color-mix(in srgb, var(--background) 84%, rgb(36 138 61));
  --revex-diff-deletion-row-bg: color-mix(in srgb, var(--background) 88%, rgb(207 34 46));
  --revex-diff-deletion-row-hover-bg: color-mix(in srgb, var(--background) 84%, rgb(207 34 46));
  --diffs-bg-addition-override: rgb(36 138 61);
  --diffs-bg-addition-number-override: rgb(36 138 61);
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 78%, rgb(36 138 61));
  --diffs-bg-deletion-override: rgb(207 34 46);
  --diffs-bg-deletion-number-override: rgb(207 34 46);
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--background) 78%, rgb(207 34 46));
  background-color: var(--diffs-bg) !important;
}

[data-line-type="change-addition"]:is([data-line], [data-column-number], [data-gutter-buffer], [data-no-newline]) {
  --diffs-line-bg: var(--revex-diff-addition-row-bg) !important;
  background-color: var(--revex-diff-addition-row-bg) !important;
}

[data-line-type="change-deletion"]:is([data-line], [data-column-number], [data-gutter-buffer], [data-no-newline]) {
  --diffs-line-bg: var(--revex-diff-deletion-row-bg) !important;
  background-color: var(--revex-diff-deletion-row-bg) !important;
}

[data-line-type="change-addition"][data-hovered]:is([data-line], [data-column-number], [data-gutter-buffer], [data-no-newline]) {
  --diffs-line-bg: var(--revex-diff-addition-row-hover-bg) !important;
  background-color: var(--revex-diff-addition-row-hover-bg) !important;
}

[data-line-type="change-deletion"][data-hovered]:is([data-line], [data-column-number], [data-gutter-buffer], [data-no-newline]) {
  --diffs-line-bg: var(--revex-diff-deletion-row-hover-bg) !important;
  background-color: var(--revex-diff-deletion-row-hover-bg) !important;
}

[data-file-info],
[data-diffs-header] {
  background-color: var(--background) !important;
  border-color: var(--border) !important;
  color: var(--foreground) !important;
}
`;

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};
const SOURCE_ORDER: Record<ReviewRouteSource, number> = {
  "branch-range": 0,
  "working-tree": 1,
};

function useReviewDiffPreview(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly baseRef?: string | null | undefined;
}) {
  const requestIdRef = useRef(0);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [state, setState] = useState<PreviewState>({
    status: "idle",
    data: null,
    error: null,
  });

  useEffect(
    () =>
      subscribeEnvironmentConnections(() => {
        setConnectionVersion((version) => version + 1);
      }),
    [],
  );

  const load = useCallback(() => {
    const cwd = input.cwd?.trim() ?? "";
    const baseRef = input.baseRef?.trim();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!input.enabled || cwd.length === 0) {
      setState({ status: "idle", data: null, error: null });
      return;
    }

    const api = readEnvironmentApi(input.environmentId);
    if (!api) {
      setState({
        status: "error",
        data: null,
        error: "Remote connection is not ready.",
      });
      return;
    }

    setState((current) => ({
      status: "loading",
      data: current.data,
      error: null,
    }));

    void api.review
      .getDiffPreview(baseRef ? { cwd, baseRef } : { cwd })
      .then((data) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setState({ status: "success", data, error: null });
      })
      .catch((error: unknown) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setState({
          status: "error",
          data: null,
          error: error instanceof Error ? error.message : "Failed to load review diff preview.",
        });
      });
  }, [connectionVersion, input.baseRef, input.cwd, input.enabled, input.environmentId]);

  useEffect(() => {
    load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [load]);

  return {
    ...state,
    refresh: load,
  };
}

function normalizePathSegments(pathValue: string): string[] {
  return pathValue
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function normalizeReviewPath(pathValue: string): string {
  return normalizePathSegments(pathValue).join("/");
}

function pathBelongsToDirectory(filePath: string, directoryPath: string): boolean {
  const normalizedFilePath = normalizeReviewPath(filePath);
  const normalizedDirectoryPath = normalizeReviewPath(directoryPath);
  return (
    normalizedDirectoryPath.length === 0 ||
    normalizedFilePath === normalizedDirectoryPath ||
    normalizedFilePath.startsWith(`${normalizedDirectoryPath}/`)
  );
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function defaultAnnotationSide(fileDiff: FileDiffMetadata): AnnotationSide {
  return fileDiff.additionLines.length > 0 ? "additions" : "deletions";
}

function formatAnnotationSide(side: AnnotationSide): string {
  return side === "additions" ? "new" : "old";
}

function formatReviewTarget(target: ReviewWorkspaceTarget | NormalizedReviewComment): string {
  const kind = "kind" in target ? target.kind : target.targetKind;
  if (kind === "folder") {
    return `Folder: ${target.path}`;
  }
  if (kind === "line") {
    const lineNumber = "lineNumber" in target ? (target.lineNumber ?? 1) : 1;
    const side = "side" in target ? (target.side ?? "additions") : "additions";
    const placement = "placement" in target ? target.placement : null;
    const prefix = placement === "file-top" ? "Top of file" : `Line ${lineNumber}`;
    return `${prefix}: ${target.path} (${formatAnnotationSide(side)})`;
  }
  return `File: ${target.path}`;
}

function isSameReviewTarget(
  comment: NormalizedReviewComment,
  target: ReviewWorkspaceTarget,
): boolean {
  if (comment.targetKind !== target.kind || comment.path !== target.path) {
    return false;
  }
  if (target.kind !== "line") {
    return true;
  }
  return (
    comment.lineNumber === target.lineNumber &&
    comment.side === target.side &&
    (comment.placement ?? "line") === target.placement
  );
}

function createLineTarget(
  filePath: string,
  line: Pick<OnDiffLineClickProps, "annotationSide" | "lineNumber">,
): Extract<ReviewWorkspaceTarget, { readonly kind: "line" }> {
  return {
    kind: "line",
    path: filePath,
    side: line.annotationSide,
    lineNumber: line.lineNumber,
    placement: "line",
  };
}

function createFileTopTarget(
  filePath: string,
  fileDiff: FileDiffMetadata,
): Extract<ReviewWorkspaceTarget, { readonly kind: "line" }> {
  return {
    kind: "line",
    path: filePath,
    side: defaultAnnotationSide(fileDiff),
    lineNumber: 1,
    placement: "file-top",
  };
}

function selectedLineRangeForFile(
  target: ReviewWorkspaceTarget | null,
  filePath: string,
): SelectedLineRange | null {
  if (!target || target.kind !== "line" || target.path !== filePath) {
    return null;
  }
  return {
    start: target.lineNumber,
    end: target.lineNumber,
    side: target.side,
    endSide: target.side,
  };
}

function compareByName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function readFileDiffStat(fileDiff: FileDiffMetadata): ReviewDiffStat {
  return fileDiff.hunks.reduce(
    (total, hunk) => ({
      additions: total.additions + hunk.additionLines,
      deletions: total.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );
}

function compactDirectoryNode(node: ReviewTreeDirectoryNode): ReviewTreeDirectoryNode {
  const children = node.children.map((child) =>
    child.kind === "directory" ? compactDirectoryNode(child) : child,
  );
  let compactedNode: ReviewTreeDirectoryNode = { ...node, children };

  while (compactedNode.children.length === 1) {
    const onlyChild = compactedNode.children[0];
    if (!onlyChild || onlyChild.kind !== "directory") {
      break;
    }
    compactedNode = {
      kind: "directory",
      name: `${compactedNode.name}/${onlyChild.name}`,
      path: onlyChild.path,
      stat: onlyChild.stat,
      children: onlyChild.children,
    };
  }

  return compactedNode;
}

function toTreeNodes(directory: MutableDirectoryNode): ReviewTreeNode[] {
  const directories = Array.from(directory.directories.values())
    .toSorted(compareByName)
    .map<ReviewTreeDirectoryNode>((child) => ({
      kind: "directory",
      name: child.name,
      path: child.path,
      stat: child.stat,
      children: toTreeNodes(child),
    }))
    .map((child) => compactDirectoryNode(child));
  const files = directory.files.toSorted(compareByName);
  return [...directories, ...files];
}

function buildReviewTree(fileDiffs: ReadonlyArray<FileDiffMetadata>): ReviewTreeNode[] {
  const root: MutableDirectoryNode = {
    name: "",
    path: "",
    stat: { additions: 0, deletions: 0 },
    directories: new Map(),
    files: [],
  };

  for (const fileDiff of fileDiffs) {
    const pathSegments = normalizePathSegments(resolveFileDiffPath(fileDiff));
    const fileName = pathSegments.at(-1);
    if (!fileName) {
      continue;
    }

    const stat = readFileDiffStat(fileDiff);
    const ancestors: MutableDirectoryNode[] = [root];
    let currentDirectory = root;

    for (const segment of pathSegments.slice(0, -1)) {
      const nextPath = currentDirectory.path ? `${currentDirectory.path}/${segment}` : segment;
      let nextDirectory = currentDirectory.directories.get(segment);
      if (!nextDirectory) {
        nextDirectory = {
          name: segment,
          path: nextPath,
          stat: { additions: 0, deletions: 0 },
          directories: new Map(),
          files: [],
        };
        currentDirectory.directories.set(segment, nextDirectory);
      }
      currentDirectory = nextDirectory;
      ancestors.push(currentDirectory);
    }

    currentDirectory.files.push({
      kind: "file",
      name: fileName,
      path: pathSegments.join("/"),
      stat,
    });

    for (const ancestor of ancestors) {
      ancestor.stat.additions += stat.additions;
      ancestor.stat.deletions += stat.deletions;
    }
  }

  return toTreeNodes(root);
}

function collectDirectoryPaths(nodes: ReadonlyArray<ReviewTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") {
      continue;
    }
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}

function hasDiffText(source: ReviewDiffPreviewSource): boolean {
  return source.diff.trim().length > 0;
}

function sourceTitle(source: ReviewDiffPreviewSource): string {
  return source.kind === "working-tree" ? "Working tree" : "Branch range";
}

function sourceSubtitle(source: ReviewDiffPreviewSource): string {
  if (source.kind === "working-tree") {
    return "HEAD plus local changes";
  }
  return `${source.baseRef ?? "base"} ... ${source.headRef ?? "HEAD"}`;
}

function normalizeSourceId(source: ReviewDiffPreviewSource): string {
  return source.id || source.kind;
}

function sortSources(
  sources: ReadonlyArray<ReviewDiffPreviewSource>,
): ReadonlyArray<ReviewDiffPreviewSource> {
  return [...sources].toSorted((left, right) => {
    const byKind = SOURCE_ORDER[left.kind] - SOURCE_ORDER[right.kind];
    if (byKind !== 0) {
      return byKind;
    }
    return normalizeSourceId(left).localeCompare(normalizeSourceId(right), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function getDefaultSource(sources: ReadonlyArray<ReviewDiffPreviewSource>) {
  const nonEmptySource = sources.find(hasDiffText);
  if (nonEmptySource) {
    return nonEmptySource;
  }
  return sources[0] ?? null;
}

function sourceMatchesRouteSource(
  source: ReviewDiffPreviewSource,
  routeSource: ReviewRouteSource | undefined,
): boolean {
  return routeSource ? source.kind === routeSource : false;
}

function isNoGitError(message: string | null): boolean {
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  return normalized.includes("not a git repository") || normalized.includes("no supported vcs");
}

function matchesCommentSource(
  commentSourceId: string | null,
  source: ReviewDiffPreviewSource | null,
): boolean {
  if (!commentSourceId || !source) {
    return true;
  }
  const normalizedSourceId = normalizeSourceId(source);
  return (
    commentSourceId === normalizedSourceId ||
    commentSourceId === source.kind ||
    commentSourceId === `git:${source.kind}`
  );
}

function normalizeWorkspaceComments(input: {
  readonly comments?: ReadonlyArray<ReviewWorkspaceComment> | undefined;
  readonly reviewComments?: ReadonlyArray<ReviewCommentContext> | undefined;
  readonly selectedSource: ReviewDiffPreviewSource | null;
}): ReadonlyArray<NormalizedReviewComment> {
  const comments: NormalizedReviewComment[] = [];

  for (const comment of input.comments ?? []) {
    if (!matchesCommentSource(comment.sourceId ?? null, input.selectedSource)) {
      continue;
    }
    comments.push({
      id: comment.id,
      targetKind: comment.targetKind,
      path: comment.path,
      body: comment.body,
      side: comment.side ?? null,
      lineNumber: comment.lineNumber ?? null,
      placement: comment.placement ?? null,
      meta: comment.authorLabel ?? null,
    });
  }

  for (const comment of input.reviewComments ?? []) {
    if (!matchesCommentSource(comment.sectionId, input.selectedSource)) {
      continue;
    }
    comments.push({
      id: comment.id,
      targetKind: "file",
      path: comment.filePath,
      body: comment.text,
      side: null,
      lineNumber: null,
      placement: null,
      meta: comment.rangeLabel,
    });
  }

  return comments;
}

function formatDiffStat(stat: ReviewDiffStat): string {
  return `+${stat.additions} -${stat.deletions}`;
}

function totalDiffStat(files: ReadonlyArray<FileDiffMetadata>): ReviewDiffStat {
  return files.reduce(
    (total, file) => {
      const stat = readFileDiffStat(file);
      return {
        additions: total.additions + stat.additions,
        deletions: total.deletions + stat.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );
}

function buildLineAnnotationsForFile(input: {
  readonly filePath: string;
  readonly comments: ReadonlyArray<NormalizedReviewComment>;
  readonly selectedTarget: ReviewWorkspaceTarget | null;
  readonly inlineCommentBody: string;
  readonly canSubmitInlineComment: boolean;
  readonly isSubmittingInlineComment: boolean;
}): DiffLineAnnotation<ReviewLineAnnotationMetadata>[] {
  const annotations: DiffLineAnnotation<ReviewLineAnnotationMetadata>[] = [];

  for (const comment of input.comments) {
    if (
      comment.targetKind !== "line" ||
      comment.path !== input.filePath ||
      comment.lineNumber === null
    ) {
      continue;
    }
    annotations.push({
      side: comment.side ?? "additions",
      lineNumber: comment.lineNumber,
      metadata: {
        kind: "comment",
        comment,
      },
    });
  }

  if (input.selectedTarget?.kind === "line" && input.selectedTarget.path === input.filePath) {
    annotations.push({
      side: input.selectedTarget.side,
      lineNumber: input.selectedTarget.lineNumber,
      metadata: {
        kind: "draft",
        target: input.selectedTarget,
        body: input.inlineCommentBody,
        canSubmit: input.canSubmitInlineComment,
        isSubmitting: input.isSubmittingInlineComment,
      },
    });
  }

  return annotations;
}

function buildFixRequest(input: {
  readonly selectedSource: ReviewDiffPreviewSource;
  readonly selectedTarget: ReviewWorkspaceTarget | null;
  readonly viewedFilePaths: ReadonlySet<string>;
}): ReviewWorkspaceFixRequest {
  return {
    sourceId: normalizeSourceId(input.selectedSource),
    sourceKind: input.selectedSource.kind,
    sourceTitle: input.selectedSource.title,
    diffHash: input.selectedSource.diffHash,
    baseRef: input.selectedSource.baseRef,
    headRef: input.selectedSource.headRef,
    target: input.selectedTarget,
    viewedFilePaths: [...input.viewedFilePaths].toSorted(),
  };
}

function buildReviewFixPrompt(input: {
  readonly scope: "selected" | "all";
  readonly selectedSource: ReviewDiffPreviewSource;
  readonly selectedTarget: ReviewWorkspaceTarget | null;
  readonly comments: ReadonlyArray<NormalizedReviewComment>;
}): string {
  const scopedComments =
    input.scope === "selected" && input.selectedTarget
      ? input.comments.filter((comment) => isSameReviewTarget(comment, input.selectedTarget!))
      : input.comments;
  const commentLines = scopedComments
    .filter((comment) => comment.body.trim().length > 0)
    .map((comment, index) => {
      const label = formatReviewTarget(comment);
      return `${index + 1}. ${label}: ${comment.body.trim()}`;
    });
  const targetLine =
    input.scope === "selected" && input.selectedTarget
      ? `Target: ${formatReviewTarget(input.selectedTarget)}`
      : "Target: all review comments in the selected source";

  return [
    input.scope === "selected"
      ? "Apply the smallest necessary changes in the current worktree to resolve the selected review target."
      : "Apply the smallest necessary changes in the current worktree to resolve all review comments in this source.",
    `Source: ${sourceTitle(input.selectedSource)} (${sourceSubtitle(input.selectedSource)})`,
    targetLine,
    commentLines.length > 0 ? ["", "Review comments:", ...commentLines].join("\n") : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildReviewCommentFixPrompt(input: {
  readonly selectedSource: ReviewDiffPreviewSource;
  readonly comment: NormalizedReviewComment;
}): string {
  return [
    "Apply the smallest necessary changes in the current worktree to resolve this review comment.",
    `Source: ${sourceTitle(input.selectedSource)} (${sourceSubtitle(input.selectedSource)})`,
    `Target: ${formatReviewTarget(input.comment)}`,
    "",
    "Review comment:",
    input.comment.body.trim() || "No comment text.",
  ].join("\n");
}

function ReviewWorkspaceEmptyState(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode | undefined;
}) {
  return (
    <div className="flex h-full min-h-64 items-center justify-center px-6 text-center">
      <div className="max-w-sm space-y-3">
        <div className="text-sm font-medium text-foreground">{props.title}</div>
        <p className="text-xs leading-5 text-muted-foreground">{props.description}</p>
        {props.action ? <div className="flex justify-center">{props.action}</div> : null}
      </div>
    </div>
  );
}

function DiffStatText({ stat }: { readonly stat: ReviewDiffStat }) {
  return (
    <span className="font-mono text-[10px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{stat.additions}</span>
      <span className="px-1 text-muted-foreground/60">/</span>
      <span className="text-red-600 dark:text-red-400">-{stat.deletions}</span>
    </span>
  );
}

function ReviewFileTree(props: {
  readonly nodes: ReadonlyArray<ReviewTreeNode>;
  readonly selectedTarget: ReviewWorkspaceTarget | null;
  readonly resolvedTheme: "light" | "dark";
  readonly viewedFilePaths: ReadonlySet<string>;
  readonly onSelectFile: (path: string) => void;
  readonly onSelectFolder: (path: string) => void;
}) {
  const directoryPaths = useMemo(() => collectDirectoryPaths(props.nodes), [props.nodes]);
  const expansionKey = directoryPaths.join("\u0000");
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    readonly key: string;
    readonly overrides: Record<string, boolean>;
  }>(() => ({ key: expansionKey, overrides: {} }));
  const expandedDirectories =
    directoryExpansionState.key === expansionKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;

  const toggleDirectory = useCallback(
    (path: string) => {
      setDirectoryExpansionState((current) => {
        const currentOverrides = current.key === expansionKey ? current.overrides : {};
        return {
          key: expansionKey,
          overrides: {
            ...currentOverrides,
            [path]: !(currentOverrides[path] ?? true),
          },
        };
      });
    },
    [expansionKey],
  );

  const renderNode = (node: ReviewTreeNode, depth: number): ReactNode => {
    const paddingLeft = 8 + depth * 12;
    if (node.kind === "directory") {
      const expanded = expandedDirectories[node.path] ?? true;
      const selected =
        props.selectedTarget?.kind === "folder" && props.selectedTarget.path === node.path;
      return (
        <div key={`directory:${node.path}`} className="space-y-0.5">
          <div
            className={cn(
              "group flex min-w-0 items-center gap-1 rounded-md py-1 pr-2 hover:bg-muted/70",
              selected && "bg-muted text-foreground",
            )}
            style={{ paddingLeft }}
          >
            <button
              type="button"
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/75 hover:bg-background hover:text-foreground"
              aria-label={expanded ? `Collapse ${node.path}` : `Expand ${node.path}`}
              onClick={() => toggleDirectory(node.path)}
            >
              <ChevronRightIcon
                className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
              />
            </button>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              title={node.path}
              onClick={() => props.onSelectFolder(node.path)}
            >
              {expanded ? (
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
              ) : (
                <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
              )}
              <span className="min-w-0 truncate font-mono text-xs font-semibold text-foreground/85 group-hover:text-foreground">
                {node.name}
              </span>
              <span className="ml-auto shrink-0">
                <DiffStatText stat={node.stat} />
              </span>
            </button>
          </div>
          {expanded ? (
            <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
          ) : null}
        </div>
      );
    }

    const selected =
      (props.selectedTarget?.kind === "file" || props.selectedTarget?.kind === "line") &&
      props.selectedTarget.path === node.path;
    const viewed = props.viewedFilePaths.has(node.path);
    return (
      <div
        key={`file:${node.path}`}
        className={cn(
          "group flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 hover:bg-muted/70",
          selected && "bg-muted text-foreground",
        )}
        style={{ paddingLeft }}
      >
        <span aria-hidden="true" className="size-4 shrink-0" />
        <VscodeEntryIcon
          pathValue={node.path}
          kind="file"
          theme={props.resolvedTheme}
          className={cn("size-3.5", viewed && "opacity-45 grayscale")}
        />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          title={`${node.path}${viewed ? " (viewed)" : ""}`}
          onClick={() => props.onSelectFile(node.path)}
        >
          <span
            className={cn(
              "block min-w-0 truncate font-mono text-xs font-semibold",
              viewed
                ? "text-muted-foreground/50 group-hover:text-muted-foreground/80"
                : "text-foreground/90 group-hover:text-foreground",
            )}
          >
            {node.name}
          </span>
        </button>
        <span className="shrink-0">
          <DiffStatText stat={node.stat} />
        </span>
      </div>
    );
  };

  return <div className="space-y-0.5">{props.nodes.map((node) => renderNode(node, 0))}</div>;
}

function ReviewCommentsPanel(props: {
  readonly comments: ReadonlyArray<NormalizedReviewComment>;
  readonly selectedSource: ReviewDiffPreviewSource | null;
  readonly selectedTarget: ReviewWorkspaceTarget | null;
  readonly onSubmitComment?:
    | ((draft: ReviewWorkspaceCommentDraft) => void | Promise<void>)
    | undefined;
  readonly onResolveComment?: ((commentId: string) => void | Promise<void>) | undefined;
  readonly onFixSelected?:
    | ((request: ReviewWorkspaceFixRequest) => void | Promise<void>)
    | undefined;
  readonly onFixAll?: ((request: ReviewWorkspaceFixRequest) => void | Promise<void>) | undefined;
  readonly onRunReviewPrompt?: ((prompt: string) => void | Promise<void>) | undefined;
  readonly isRunDisabled?: boolean | undefined;
  readonly viewedFilePaths: ReadonlySet<string>;
}) {
  const [commentBody, setCommentBody] = useState("");
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [fixPending, setFixPending] = useState<ReviewFixPending | null>(null);
  const fileComments = props.comments.filter((comment) => comment.targetKind === "file");
  const folderComments = props.comments.filter((comment) => comment.targetKind === "folder");
  const lineComments = props.comments.filter((comment) => comment.targetKind === "line");
  const selectedSource = props.selectedSource;
  const selectedTarget = props.selectedTarget;
  const commentFixPendingId = fixPending?.startsWith("comment:")
    ? fixPending.slice("comment:".length)
    : null;
  const canSubmitComment =
    Boolean(props.onSubmitComment) &&
    Boolean(selectedSource) &&
    Boolean(selectedTarget) &&
    commentBody.trim().length > 0 &&
    !isSubmittingComment;

  const cancelComment = useCallback(() => {
    setCommentBody("");
  }, []);

  const runSubmitComment = useCallback(() => {
    if (!props.onSubmitComment || !selectedSource || !selectedTarget || !canSubmitComment) {
      return;
    }

    setIsSubmittingComment(true);
    void Promise.resolve(
      props.onSubmitComment({
        sourceId: normalizeSourceId(selectedSource),
        sourceKind: selectedSource.kind,
        sourceTitle: selectedSource.title,
        diffHash: selectedSource.diffHash,
        baseRef: selectedSource.baseRef,
        headRef: selectedSource.headRef,
        target: selectedTarget,
        body: commentBody.trim(),
      }),
    )
      .then(() => {
        setCommentBody("");
      })
      .catch((error: unknown) => {
        console.warn("Failed to submit review comment.", error);
      })
      .finally(() => {
        setIsSubmittingComment(false);
      });
  }, [canSubmitComment, commentBody, props.onSubmitComment, selectedSource, selectedTarget]);

  const runFix = useCallback(
    (scope: "selected" | "all") => {
      if (!selectedSource) {
        return;
      }
      const callback = scope === "selected" ? props.onFixSelected : props.onFixAll;
      if (!callback && !props.onRunReviewPrompt) {
        return;
      }
      setFixPending(scope);
      const target = scope === "selected" ? selectedTarget : null;
      const request = buildFixRequest({
        selectedSource,
        selectedTarget: target,
        viewedFilePaths: props.viewedFilePaths,
      });
      const work = callback
        ? callback(request)
        : props.onRunReviewPrompt?.(
            buildReviewFixPrompt({
              scope,
              selectedSource,
              selectedTarget: target,
              comments: props.comments,
            }),
          );
      void Promise.resolve(work)
        .catch((error: unknown) => {
          console.warn("Failed to run review fix action.", error);
        })
        .finally(() => {
          setFixPending((current) => (current === scope ? null : current));
        });
    },
    [
      props.comments,
      props.onFixAll,
      props.onFixSelected,
      props.onRunReviewPrompt,
      props.viewedFilePaths,
      selectedSource,
      selectedTarget,
    ],
  );
  const runFixComment = useCallback(
    (comment: NormalizedReviewComment) => {
      if (!selectedSource || !props.onRunReviewPrompt) {
        return;
      }
      const pendingKey = `comment:${comment.id}` as const;
      setFixPending(pendingKey);
      void Promise.resolve(
        props.onRunReviewPrompt(
          buildReviewCommentFixPrompt({
            selectedSource,
            comment,
          }),
        ),
      )
        .catch((error: unknown) => {
          console.warn("Failed to run review comment fix action.", error);
        })
        .finally(() => {
          setFixPending((current) => (current === pendingKey ? null : current));
        });
    },
    [props.onRunReviewPrompt, selectedSource],
  );
  const runResolveComment = useCallback(
    (commentId: string) => {
      if (!props.onResolveComment) {
        return;
      }
      void Promise.resolve(props.onResolveComment(commentId)).catch((error: unknown) => {
        console.warn("Failed to resolve review comment.", error);
      });
    },
    [props.onResolveComment],
  );

  return (
    <aside className="flex min-h-0 flex-col border-l border-border/70 bg-background">
      <div className="border-b border-border/70 px-3 py-2">
        <div className="text-xs font-medium text-foreground">Review notes</div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {selectedTarget ? formatReviewTarget(selectedTarget) : "Select a file or folder"}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3">
        {(props.onFixSelected || props.onFixAll || props.onRunReviewPrompt) && (
          <div className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Actions
            </div>
            <div className="grid grid-cols-2 gap-2">
              {props.onFixSelected || props.onRunReviewPrompt ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={
                    !selectedSource ||
                    !selectedTarget ||
                    fixPending !== null ||
                    props.isRunDisabled === true
                  }
                  onClick={() => runFix("selected")}
                >
                  {fixPending === "selected" ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <WandSparklesIcon className="size-3.5" />
                  )}
                  Fix target
                </Button>
              ) : null}
              {props.onFixAll || props.onRunReviewPrompt ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!selectedSource || fixPending !== null || props.isRunDisabled === true}
                  onClick={() => runFix("all")}
                >
                  {fixPending === "all" ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <CheckIcon className="size-3.5" />
                  )}
                  Fix all
                </Button>
              ) : null}
            </div>
          </div>
        )}

        {props.onSubmitComment ? (
          <div className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Add comment
            </div>
            <Textarea
              size="sm"
              value={commentBody}
              placeholder="Leave a review comment"
              data-review-comment-textarea="true"
              onChange={(event) => setCommentBody(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelComment();
                  event.currentTarget.blur();
                }
              }}
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={commentBody.length === 0 || isSubmittingComment}
                onClick={cancelComment}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="xs"
                disabled={!canSubmitComment}
                onClick={runSubmitComment}
              >
                {isSubmittingComment ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <MessageSquarePlusIcon className="size-3.5" />
                )}
                Add comment
              </Button>
            </div>
          </div>
        ) : null}

        <CommentGroup
          title="Line comments"
          comments={lineComments}
          selectedSource={selectedSource}
          onFixComment={props.onRunReviewPrompt ? runFixComment : undefined}
          onResolveComment={props.onResolveComment ? runResolveComment : undefined}
          commentFixPendingId={commentFixPendingId}
          commentFixDisabled={fixPending !== null || props.isRunDisabled === true}
        />
        <CommentGroup
          title="File comments"
          comments={fileComments}
          selectedSource={selectedSource}
          onFixComment={props.onRunReviewPrompt ? runFixComment : undefined}
          onResolveComment={props.onResolveComment ? runResolveComment : undefined}
          commentFixPendingId={commentFixPendingId}
          commentFixDisabled={fixPending !== null || props.isRunDisabled === true}
        />
        <CommentGroup
          title="Folder comments"
          comments={folderComments}
          selectedSource={selectedSource}
          onFixComment={props.onRunReviewPrompt ? runFixComment : undefined}
          onResolveComment={props.onResolveComment ? runResolveComment : undefined}
          commentFixPendingId={commentFixPendingId}
          commentFixDisabled={fixPending !== null || props.isRunDisabled === true}
        />
      </div>
    </aside>
  );
}

function CommentGroup(props: {
  readonly title: string;
  readonly comments: ReadonlyArray<NormalizedReviewComment>;
  readonly selectedSource: ReviewDiffPreviewSource | null;
  readonly onFixComment?: ((comment: NormalizedReviewComment) => void) | undefined;
  readonly onResolveComment?: ((commentId: string) => void) | undefined;
  readonly commentFixPendingId: string | null;
  readonly commentFixDisabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {props.title}
        </div>
        <div className="font-mono text-[10px] text-muted-foreground/70">
          {props.comments.length}
        </div>
      </div>
      {props.comments.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/70 px-2 py-2 text-center text-[11px] text-muted-foreground">
          No comments yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border/70 bg-background">
          {props.comments.map((comment) => (
            <div
              key={comment.id}
              className="group min-w-0 space-y-1.5 border-border/70 border-b px-2 py-1.5 last:border-b-0 hover:bg-muted/35"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <div
                    className="shrink-0 truncate font-mono text-[10px] text-foreground"
                    title={formatReviewTarget(comment)}
                  >
                    {formatReviewTarget(comment)}
                  </div>
                  {comment.meta ? (
                    <div
                      className="min-w-0 truncate text-[10px] text-muted-foreground/70"
                      title={comment.meta}
                    >
                      {comment.meta}
                    </div>
                  ) : null}
                </div>
                <div
                  className="truncate text-xs text-muted-foreground"
                  title={comment.body || "No comment text."}
                >
                  {comment.body || "No comment text."}
                </div>
              </div>
              <div className="flex justify-end gap-1">
                {props.onFixComment ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-[10px]"
                    disabled={
                      !props.selectedSource ||
                      props.commentFixDisabled ||
                      props.commentFixPendingId === comment.id
                    }
                    onClick={() => props.onFixComment?.(comment)}
                  >
                    {props.commentFixPendingId === comment.id ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <WandSparklesIcon className="size-3" />
                    )}
                    Fix
                  </Button>
                ) : null}
                {props.onResolveComment ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                    aria-label={`Resolve comment for ${formatReviewTarget(comment)}`}
                    title="Resolve comment"
                    onClick={() => props.onResolveComment?.(comment.id)}
                  >
                    <CheckIcon className="size-3" />
                    Resolve
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const ReviewWorkspace = memo(function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const reviewCwd = props.gitCwd ?? props.cwd;
  const preview = useReviewDiffPreview({
    enabled: props.isGitRepo,
    environmentId: props.environmentId,
    cwd: reviewCwd,
    baseRef: null,
  });
  const [localFolderTarget, setLocalFolderTarget] = useState<ReviewWorkspaceTarget | null>(null);
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("inline");
  const [wordWrap, setWordWrap] = useState(true);
  const [collapsedFileKeys, setCollapsedFileKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [viewedFilePaths, setViewedFilePaths] = useState<ReadonlySet<string>>(() => new Set());
  const [localLineTarget, setLocalLineTarget] = useState<Extract<
    ReviewWorkspaceTarget,
    { readonly kind: "line" }
  > | null>(null);
  const [inlineCommentBody, setInlineCommentBody] = useState("");
  const [isSubmittingInlineComment, setIsSubmittingInlineComment] = useState(false);

  const sources = useMemo(() => sortSources(preview.data?.sources ?? []), [preview.data?.sources]);
  const defaultSource = useMemo(() => getDefaultSource(sources), [sources]);
  const selectedSource = useMemo(
    () =>
      sources.find((source) => sourceMatchesRouteSource(source, props.selectedSource)) ??
      defaultSource,
    [defaultSource, props.selectedSource, sources],
  );
  const selectedSourceKey = selectedSource ? normalizeSourceId(selectedSource) : "none";
  const renderablePatch = useMemo(() => {
    if (!selectedSource) {
      return null;
    }
    return getRenderablePatch(
      selectedSource.diff,
      `review-workspace:${selectedSourceKey}:${selectedSource.diffHash}:${props.resolvedTheme}`,
    );
  }, [props.resolvedTheme, selectedSource, selectedSourceKey]);
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const treeNodes = useMemo(() => buildReviewTree(renderableFiles), [renderableFiles]);
  const allDirectoryPaths = useMemo(() => collectDirectoryPaths(treeNodes), [treeNodes]);
  const summaryStat = useMemo(() => totalDiffStat(renderableFiles), [renderableFiles]);
  const allFilePaths = useMemo(
    () => renderableFiles.map((fileDiff) => resolveFileDiffPath(fileDiff)),
    [renderableFiles],
  );
  const allSourcesEmpty = sources.length > 0 && sources.every((source) => !hasDiffText(source));
  const isInitialLoading = preview.status === "loading" && !preview.data;
  const isRefreshing = preview.status === "loading" && Boolean(preview.data);
  const selectedFilePath =
    props.selectedFilePath && allFilePaths.includes(props.selectedFilePath)
      ? props.selectedFilePath
      : (allFilePaths[0] ?? null);
  const visibleDirectoryPathSet = useMemo(() => new Set(allDirectoryPaths), [allDirectoryPaths]);
  const selectedTarget =
    localLineTarget && selectedFilePath === localLineTarget.path
      ? localLineTarget
      : localFolderTarget && visibleDirectoryPathSet.has(localFolderTarget.path)
        ? localFolderTarget
        : selectedFilePath
          ? ({ kind: "file", path: selectedFilePath } satisfies ReviewWorkspaceTarget)
          : null;
  const displayedFiles = useMemo(() => {
    if (!selectedTarget) {
      return renderableFiles;
    }
    if (selectedTarget.kind === "file") {
      return renderableFiles.filter(
        (fileDiff) => resolveFileDiffPath(fileDiff) === selectedTarget.path,
      );
    }
    return renderableFiles.filter((fileDiff) =>
      pathBelongsToDirectory(resolveFileDiffPath(fileDiff), selectedTarget.path),
    );
  }, [renderableFiles, selectedTarget]);
  const normalizedComments = useMemo(
    () =>
      normalizeWorkspaceComments({
        comments: props.comments,
        reviewComments: props.reviewComments,
        selectedSource,
      }),
    [props.comments, props.reviewComments, selectedSource],
  );
  const canSubmitInlineComment =
    Boolean(props.onSubmitComment) &&
    Boolean(selectedSource) &&
    selectedTarget?.kind === "line" &&
    inlineCommentBody.trim().length > 0 &&
    !isSubmittingInlineComment;

  useEffect(() => {
    if (!defaultSource || !props.isGitRepo) {
      return;
    }
    const selectedRouteSourceExists = sources.some((source) =>
      sourceMatchesRouteSource(source, props.selectedSource),
    );
    if (!selectedRouteSourceExists) {
      props.onSelectedSourceChange(defaultSource.kind, defaultSource.baseRef);
    }
  }, [defaultSource, props.isGitRepo, props.onSelectedSourceChange, props.selectedSource, sources]);

  useEffect(() => {
    setCollapsedFileKeys((current) => {
      if (renderableFiles.length === 0) {
        return current.size === 0 ? current : new Set();
      }
      const visibleFileKeys = new Set(renderableFiles.map(buildFileDiffRenderKey));
      const next = new Set([...current].filter((fileKey) => visibleFileKeys.has(fileKey)));
      return next.size === current.size ? current : next;
    });
  }, [renderableFiles]);

  useEffect(() => {
    const visiblePaths = new Set(allFilePaths);
    setViewedFilePaths((current) => {
      const next = new Set([...current].filter((path) => visiblePaths.has(path)));
      return next.size === current.size ? current : next;
    });

    if (props.selectedFilePath && !visiblePaths.has(props.selectedFilePath)) {
      props.onSelectedFilePathChange(undefined);
    }
  }, [allFilePaths, props.onSelectedFilePathChange, props.selectedFilePath]);

  useEffect(() => {
    if (localLineTarget && selectedFilePath !== localLineTarget.path) {
      setLocalLineTarget(null);
      setInlineCommentBody("");
    }
  }, [localLineTarget, selectedFilePath]);

  const selectFile = useCallback(
    (path: string) => {
      setLocalFolderTarget(null);
      setLocalLineTarget(null);
      setInlineCommentBody("");
      props.onSelectedFilePathChange(path);
    },
    [props.onSelectedFilePathChange],
  );

  const selectFolder = useCallback((path: string) => {
    setLocalFolderTarget({ kind: "folder", path });
    setLocalLineTarget(null);
    setInlineCommentBody("");
  }, []);

  const selectLineTarget = useCallback(
    (target: Extract<ReviewWorkspaceTarget, { readonly kind: "line" }>) => {
      setLocalFolderTarget(null);
      setLocalLineTarget(target);
      setInlineCommentBody("");
      props.onSelectedFilePathChange(target.path);
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLTextAreaElement>("[data-review-inline-comment-textarea='true']")
          ?.focus();
      });
    },
    [props.onSelectedFilePathChange],
  );

  const toggleViewed = useCallback((path: string) => {
    setViewedFilePaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const markViewed = useCallback((path: string) => {
    setViewedFilePaths((current) => {
      if (current.has(path)) {
        return current;
      }
      const next = new Set(current);
      next.add(path);
      return next;
    });
  }, []);

  const toggleFileCollapsed = useCallback((fileKey: string) => {
    setCollapsedFileKeys((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  }, []);

  const selectFileByOffset = useCallback(
    (offset: number) => {
      if (allFilePaths.length === 0) {
        return;
      }
      const currentIndex = selectedFilePath ? allFilePaths.indexOf(selectedFilePath) : -1;
      const fallbackIndex = offset > 0 ? -1 : allFilePaths.length;
      const nextIndex = Math.min(
        allFilePaths.length - 1,
        Math.max(0, (currentIndex >= 0 ? currentIndex : fallbackIndex) + offset),
      );
      const nextPath = allFilePaths[nextIndex];
      if (nextPath) {
        selectFile(nextPath);
      }
    },
    [allFilePaths, selectFile, selectedFilePath],
  );

  const runSubmitInlineComment = useCallback(() => {
    if (
      !props.onSubmitComment ||
      !selectedSource ||
      selectedTarget?.kind !== "line" ||
      !canSubmitInlineComment
    ) {
      return;
    }

    setIsSubmittingInlineComment(true);
    void Promise.resolve(
      props.onSubmitComment({
        sourceId: normalizeSourceId(selectedSource),
        sourceKind: selectedSource.kind,
        sourceTitle: selectedSource.title,
        diffHash: selectedSource.diffHash,
        baseRef: selectedSource.baseRef,
        headRef: selectedSource.headRef,
        target: selectedTarget,
        body: inlineCommentBody.trim(),
      }),
    )
      .then(() => {
        setInlineCommentBody("");
        setLocalLineTarget(null);
      })
      .catch((error: unknown) => {
        console.warn("Failed to submit inline review comment.", error);
      })
      .finally(() => {
        setIsSubmittingInlineComment(false);
      });
  }, [
    canSubmitInlineComment,
    inlineCommentBody,
    props.onSubmitComment,
    selectedSource,
    selectedTarget,
  ]);

  const cancelInlineComment = useCallback(() => {
    setInlineCommentBody("");
    setLocalLineTarget(null);
  }, []);

  const renderLineAnnotation = useCallback(
    (annotation: DiffLineAnnotation<ReviewLineAnnotationMetadata>) => {
      const metadata = annotation.metadata;
      if (metadata.kind === "comment") {
        return (
          <div className="my-1 rounded-md border border-border/70 bg-muted/25 p-2 text-xs">
            <div className="mb-1 truncate font-mono text-[11px] text-foreground">
              {formatReviewTarget(metadata.comment)}
            </div>
            <div className="whitespace-pre-wrap wrap-break-word leading-5 text-muted-foreground">
              {metadata.comment.body}
            </div>
          </div>
        );
      }

      return (
        <div className="my-1 rounded-md border border-ring/35 bg-background p-2 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="truncate font-mono text-[11px] text-foreground">
              {formatReviewTarget(metadata.target)}
            </div>
            <div className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
              Draft
            </div>
          </div>
          <Textarea
            size="sm"
            value={metadata.body}
            placeholder="Write a review comment"
            data-review-inline-comment-textarea="true"
            onChange={(event) => setInlineCommentBody(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelInlineComment();
                event.currentTarget.blur();
                return;
              }
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                runSubmitInlineComment();
              }
            }}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={metadata.isSubmitting}
              onClick={cancelInlineComment}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={!metadata.canSubmit}
              onClick={runSubmitInlineComment}
            >
              {metadata.isSubmitting ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <MessageSquarePlusIcon className="size-3.5" />
              )}
              Add comment
            </Button>
          </div>
        </div>
      );
    },
    [cancelInlineComment, runSubmitInlineComment],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableEventTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "escape" && selectedTarget?.kind === "line") {
        event.preventDefault();
        cancelInlineComment();
        return;
      }

      if (key === "v" && selectedTarget && selectedTarget.kind !== "folder") {
        event.preventDefault();
        markViewed(selectedTarget.path);
        selectFileByOffset(1);
        return;
      }

      if (event.shiftKey && key === "arrowdown") {
        event.preventDefault();
        selectFileByOffset(1);
        return;
      }

      if (event.shiftKey && key === "arrowup") {
        event.preventDefault();
        selectFileByOffset(-1);
        return;
      }

      if (key === "w" && props.onSubmitComment && selectedSource && selectedTarget) {
        event.preventDefault();
        document
          .querySelector<HTMLTextAreaElement>("[data-review-comment-textarea='true']")
          ?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    cancelInlineComment,
    markViewed,
    props.onSubmitComment,
    selectFileByOffset,
    selectedSource,
    selectedTarget,
  ]);

  const selectedSourceHasDiff = selectedSource ? hasDiffText(selectedSource) : false;
  const noGit = !props.isGitRepo || (preview.status === "success" && sources.length === 0);
  const errorIsNoGit = preview.status === "error" && isNoGitError(preview.error);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      data-review-workspace="true"
      data-review-environment-id={props.environmentId}
      data-review-thread-id={props.threadId}
      data-review-theme={props.resolvedTheme}
      data-review-git-repo={props.isGitRepo ? "true" : "false"}
      data-review-source={props.selectedSource}
      data-review-base-ref={props.selectedBaseRef}
      data-review-file-path={props.selectedFilePath}
      data-review-cwd={props.cwd ?? undefined}
      data-review-git-cwd={props.gitCwd ?? undefined}
    >
      <header className="flex min-h-12 items-center gap-3 border-b border-border/70 px-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitCompareArrowsIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="truncate text-sm font-medium text-foreground">Review workspace</div>
            {renderableFiles.length > 0 ? (
              <div className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:flex">
                <span>{renderableFiles.length} files</span>
                <span className="text-muted-foreground/50">·</span>
                <span>{formatDiffStat(summaryStat)}</span>
              </div>
            ) : null}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {reviewCwd ?? "No workspace selected"}
          </div>
        </div>

        {sources.length > 1 ? (
          <ToggleGroup
            variant="outline"
            size="xs"
            value={selectedSource ? [selectedSource.kind] : []}
            onValueChange={(value) => {
              const next = value[0];
              const source = next
                ? sources.find((candidate) => candidate.kind === next)
                : undefined;
              if (source) {
                props.onSelectedSourceChange(source.kind, source.baseRef);
              }
            }}
          >
            {sources.map((source) => (
              <Toggle
                key={normalizeSourceId(source)}
                className="px-3"
                value={source.kind}
                aria-label={`Show ${sourceTitle(source)}`}
                title={sourceSubtitle(source)}
              >
                {source.kind === "branch-range" ? (
                  <GitBranchIcon className="size-3.5" />
                ) : (
                  <GitCompareArrowsIcon className="size-3.5" />
                )}
                <span className="hidden sm:inline">{sourceTitle(source)}</span>
              </Toggle>
            ))}
          </ToggleGroup>
        ) : selectedSource ? (
          <div className="hidden min-w-0 max-w-56 truncate text-right text-xs text-muted-foreground md:block">
            {sourceSubtitle(selectedSource)}
          </div>
        ) : null}

        <ToggleGroup
          variant="outline"
          size="xs"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "inline" || next === "split") {
              setDiffRenderMode(next);
            }
          }}
        >
          <Toggle value="inline" aria-label="Inline diff view">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle value="split" aria-label="Split diff view">
            <Columns2Icon className="size-3.5" />
          </Toggle>
        </ToggleGroup>

        <Button
          type="button"
          size="icon-xs"
          variant="outline"
          aria-label="Refresh review diff"
          title="Refresh"
          disabled={isInitialLoading || !props.isGitRepo}
          onClick={preview.refresh}
        >
          <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
        </Button>
      </header>

      {isInitialLoading ? (
        <ReviewWorkspaceEmptyState
          title="Loading review diff"
          description="Fetching the current branch and working-tree diff from the environment."
          action={<Spinner className="size-4 text-muted-foreground" />}
        />
      ) : !reviewCwd ? (
        <ReviewWorkspaceEmptyState
          title="No workspace selected"
          description="Open a project or thread with a workspace path to review changes."
        />
      ) : noGit || errorIsNoGit ? (
        <ReviewWorkspaceEmptyState
          title="No git repository"
          description="Review diffs are available when the selected workspace is inside a git repository."
          action={
            props.isGitRepo ? (
              <Button type="button" size="xs" variant="outline" onClick={preview.refresh}>
                <RefreshCwIcon className="size-3.5" />
                Refresh
              </Button>
            ) : null
          }
        />
      ) : preview.status === "error" ? (
        <ReviewWorkspaceEmptyState
          title="Could not load review diff"
          description={preview.error ?? "The environment did not return a review diff."}
          action={
            <Button type="button" size="xs" variant="outline" onClick={preview.refresh}>
              <RefreshCwIcon className="size-3.5" />
              Retry
            </Button>
          }
        />
      ) : allSourcesEmpty ? (
        <ReviewWorkspaceEmptyState
          title="No changes to review"
          description="The branch range and working tree do not contain diffable changes."
          action={
            <Button type="button" size="xs" variant="outline" onClick={preview.refresh}>
              <RefreshCwIcon className="size-3.5" />
              Refresh
            </Button>
          }
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,360px)_minmax(0,1fr)_minmax(220px,280px)]">
          <aside className="flex min-h-0 flex-col border-r border-border/70 bg-background">
            <div className="border-b border-border/70 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-xs font-medium text-foreground">
                  {selectedSource ? sourceTitle(selectedSource) : "Files"}
                </div>
                {renderableFiles.length > 0 ? (
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {viewedFilePaths.size}/{renderableFiles.length}
                  </div>
                ) : null}
              </div>
              {selectedSource ? (
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {sourceSubtitle(selectedSource)}
                </div>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {treeNodes.length > 0 ? (
                <ReviewFileTree
                  nodes={treeNodes}
                  selectedTarget={selectedTarget}
                  resolvedTheme={props.resolvedTheme}
                  viewedFilePaths={viewedFilePaths}
                  onSelectFile={selectFile}
                  onSelectFolder={selectFolder}
                />
              ) : (
                <div className="px-2 py-8 text-center text-xs text-muted-foreground">
                  No files in this source.
                </div>
              )}
            </div>
          </aside>

          <main className="flex min-h-0 min-w-0 flex-col bg-background">
            {selectedSource?.truncated ? (
              <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Diff output hit the server size cap. Showing the available excerpt.
              </div>
            ) : null}

            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
              {!selectedSource ? (
                <ReviewWorkspaceEmptyState
                  title="No diff source selected"
                  description="Choose a review source to inspect its files."
                />
              ) : !selectedSourceHasDiff ? (
                <ReviewWorkspaceEmptyState
                  title="No changes in this source"
                  description={`${sourceTitle(selectedSource)} does not contain diffable changes.`}
                />
              ) : renderablePatch?.kind === "files" && displayedFiles.length === 0 ? (
                <ReviewWorkspaceEmptyState
                  title="No files for this selection"
                  description="Choose a different file or folder from the review tree."
                />
              ) : renderablePatch?.kind === "files" ? (
                <DiffWorkerPoolProvider>
                  <Virtualizer
                    className="h-full min-h-0 overflow-auto px-3 pb-3"
                    config={{
                      overscrollSize: 600,
                      intersectionObserverMargin: 1200,
                    }}
                  >
                    {displayedFiles.map((fileDiff) => {
                      const filePath = resolveFileDiffPath(fileDiff);
                      const fileKey = buildFileDiffRenderKey(fileDiff);
                      const collapsed = collapsedFileKeys.has(fileKey);
                      const selected =
                        (selectedTarget?.kind === "file" || selectedTarget?.kind === "line") &&
                        selectedTarget.path === filePath;
                      const lineAnnotations = buildLineAnnotationsForFile({
                        filePath,
                        comments: normalizedComments,
                        selectedTarget,
                        inlineCommentBody,
                        canSubmitInlineComment,
                        isSubmittingInlineComment,
                      });
                      const selectedLines = selectedLineRangeForFile(selectedTarget, filePath);
                      return (
                        <div
                          key={`${fileKey}:${props.resolvedTheme}`}
                          data-review-diff-file-path={filePath}
                          className={cn(
                            "mb-2 rounded-md first:mt-3 last:mb-0",
                            selected && "ring-1 ring-ring/60",
                          )}
                        >
                          <FileDiff
                            fileDiff={fileDiff}
                            lineAnnotations={lineAnnotations}
                            selectedLines={selectedLines}
                            renderAnnotation={renderLineAnnotation}
                            renderHeaderPrefix={() => (
                              <button
                                type="button"
                                className={cn(
                                  "inline-flex size-5 shrink-0 items-center justify-center rounded-sm bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                                  getDiffCollapseIconClassName(fileDiff),
                                )}
                                aria-label={
                                  collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`
                                }
                                aria-expanded={!collapsed}
                                title={collapsed ? "Expand diff" : "Collapse diff"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleFileCollapsed(fileKey);
                                }}
                              >
                                {collapsed ? (
                                  <ChevronRightIcon className="size-4" />
                                ) : (
                                  <ChevronDownIcon className="size-4" />
                                )}
                              </button>
                            )}
                            renderHeaderMetadata={() => (
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                disabled={!props.onSubmitComment}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  selectLineTarget(createFileTopTarget(filePath, fileDiff));
                                }}
                              >
                                <MessageSquarePlusIcon className="size-3.5" />
                                Top
                              </Button>
                            )}
                            options={{
                              collapsed,
                              diffStyle: diffRenderMode === "split" ? "split" : "unified",
                              enableLineSelection: true,
                              lineHoverHighlight: "line",
                              lineDiffType: "none",
                              onLineClick: (line) => {
                                selectLineTarget(createLineTarget(filePath, line));
                              },
                              onLineNumberClick: (line) => {
                                selectLineTarget(createLineTarget(filePath, line));
                              },
                              overflow: wordWrap ? "wrap" : "scroll",
                              theme: resolveDiffThemeName(props.resolvedTheme),
                              themeType: props.resolvedTheme as DiffThemeType,
                              unsafeCSS: REVIEW_DIFF_UNSAFE_CSS,
                            }}
                          />
                        </div>
                      );
                    })}
                  </Virtualizer>
                </DiffWorkerPoolProvider>
              ) : renderablePatch?.kind === "raw" ? (
                <div className="h-full overflow-auto p-3">
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">{renderablePatch.reason}</p>
                    <pre
                      className={cn(
                        "rounded-md border border-border/70 bg-muted/25 p-3 font-mono text-xs leading-5 text-muted-foreground",
                        wordWrap ? "whitespace-pre-wrap wrap-break-word" : "overflow-auto",
                      )}
                    >
                      {renderablePatch.text}
                    </pre>
                  </div>
                </div>
              ) : (
                <ReviewWorkspaceEmptyState
                  title="No renderable patch"
                  description="The selected review source did not produce a renderable patch."
                />
              )}
            </div>

            <div className="flex min-h-9 items-center justify-between border-t border-border/70 px-3 text-[11px] text-muted-foreground">
              <button
                type="button"
                className="rounded-md px-1.5 py-1 hover:bg-muted hover:text-foreground"
                onClick={() => setWordWrap((value) => !value)}
              >
                {wordWrap ? "Wrap on" : "Wrap off"}
              </button>
              {selectedTarget ? (
                <div className="min-w-0 truncate">
                  Selected {selectedTarget.kind}: {selectedTarget.path}
                </div>
              ) : null}
            </div>
          </main>

          <ReviewCommentsPanel
            comments={normalizedComments}
            selectedSource={selectedSource}
            selectedTarget={selectedTarget}
            viewedFilePaths={viewedFilePaths}
            onSubmitComment={props.onSubmitComment}
            onFixSelected={props.onFixSelected}
            onFixAll={props.onFixAll}
            onRunReviewPrompt={props.onRunReviewPrompt}
            onResolveComment={props.onResolveComment}
            isRunDisabled={props.isRunDisabled}
          />
        </div>
      )}
    </section>
  );
});

export default ReviewWorkspace;
