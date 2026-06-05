import type { ScopedThreadRef } from "@t3tools/contracts";

export type ReviewCommentAnchorKind = "file" | "folder";

export interface ReviewCommentRange {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rangeLabel?: string | null;
}

export interface ReviewCommentSourceMetadata {
  readonly title?: string | null;
  readonly baseRef?: string | null;
  readonly headRef?: string | null;
  readonly baseSha?: string | null;
  readonly headSha?: string | null;
}

interface ReviewCommentAnchorBase {
  readonly threadRef: ScopedThreadRef;
  readonly sourceId: string;
  readonly sectionId: string;
  readonly sectionTitle?: string | null;
  readonly diffHash: string;
  readonly range?: ReviewCommentRange | null;
  readonly source?: ReviewCommentSourceMetadata | null;
}

export interface FileReviewCommentAnchor extends ReviewCommentAnchorBase {
  readonly kind: "file";
  readonly filePath: string;
}

export interface FolderReviewCommentAnchor extends ReviewCommentAnchorBase {
  readonly kind: "folder";
  readonly folderPath: string;
}

export type ReviewCommentAnchor = FileReviewCommentAnchor | FolderReviewCommentAnchor;

export interface NormalizedReviewCommentRange {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rangeLabel: string;
}

function normalizeReviewCommentRangeIndex(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

export function normalizeReviewCommentPath(path: string, kind: ReviewCommentAnchorKind): string {
  const normalized = path.trim().replaceAll("\\", "/");
  if (kind === "folder") {
    return normalized.replace(/\/+$/g, "") || ".";
  }
  return normalized;
}

export function getReviewCommentTargetPath(anchor: ReviewCommentAnchor): string {
  if (anchor.kind === "folder") {
    return normalizeReviewCommentPath(anchor.folderPath, anchor.kind);
  }
  return normalizeReviewCommentPath(anchor.filePath, anchor.kind);
}

export function normalizeReviewCommentRange(
  range: ReviewCommentRange | null | undefined,
): NormalizedReviewCommentRange | null {
  if (!range) {
    return null;
  }

  const first = normalizeReviewCommentRangeIndex(range.startIndex);
  const last = normalizeReviewCommentRangeIndex(range.endIndex);
  const startIndex = Math.min(first, last);
  const endIndex = Math.max(first, last);
  const rangeLabel = range.rangeLabel?.trim() || (startIndex === endIndex ? "line" : "lines");

  return { startIndex, endIndex, rangeLabel };
}

export function getReviewCommentParserRange(
  anchor: ReviewCommentAnchor,
): NormalizedReviewCommentRange {
  const range = normalizeReviewCommentRange(anchor.range);
  if (range) {
    return range;
  }

  return {
    startIndex: 0,
    endIndex: 0,
    rangeLabel: anchor.kind,
  };
}

export function getReviewCommentSectionTitle(anchor: ReviewCommentAnchor): string {
  const baseTitle = anchor.sectionTitle?.trim() || anchor.source?.title?.trim() || "Review";
  if (anchor.kind !== "folder") {
    return baseTitle;
  }

  const folderPath = getReviewCommentTargetPath(anchor);
  if (baseTitle.includes(folderPath)) {
    return baseTitle;
  }

  return `${baseTitle} (folder: ${folderPath})`;
}
