import {
  getReviewCommentParserRange,
  getReviewCommentSectionTitle,
  getReviewCommentTargetPath,
  type ReviewCommentAnchor,
} from "./reviewCommentAnchor";

export interface ReviewCommentPromptComment {
  readonly anchor: ReviewCommentAnchor;
  readonly text: string;
  readonly diff?: string | null;
}

function escapeReviewCommentAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeReviewCommentBody(value: string): string {
  return value.trim().replace(/<\/review_comment>/gi, "<\\/review_comment>");
}

function optionalAttribute(name: string, value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  return ` ${name}="${escapeReviewCommentAttribute(normalized)}"`;
}

export function serializeReviewCommentBlock(comment: ReviewCommentPromptComment): string {
  const { anchor } = comment;
  const range = getReviewCommentParserRange(anchor);
  const targetPath = getReviewCommentTargetPath(anchor);
  const source = anchor.source;
  const attributes = [
    optionalAttribute("sectionId", anchor.sectionId),
    optionalAttribute("sectionTitle", getReviewCommentSectionTitle(anchor)),
    optionalAttribute("filePath", targetPath),
    optionalAttribute("startIndex", String(range.startIndex)),
    optionalAttribute("endIndex", String(range.endIndex)),
    optionalAttribute("rangeLabel", range.rangeLabel),
    optionalAttribute("sourceId", anchor.sourceId),
    optionalAttribute("diffHash", anchor.diffHash),
    optionalAttribute("targetKind", anchor.kind),
    anchor.kind === "folder" ? optionalAttribute("folderPath", targetPath) : null,
    optionalAttribute("sourceTitle", source?.title),
    optionalAttribute("baseRef", source?.baseRef),
    optionalAttribute("headRef", source?.headRef),
    optionalAttribute("baseSha", source?.baseSha),
    optionalAttribute("headSha", source?.headSha),
  ].filter((attribute): attribute is string => attribute !== null);

  const lines = [`<review_comment${attributes.join("")}>`, escapeReviewCommentBody(comment.text)];
  const diff = comment.diff?.trim();
  if (diff) {
    lines.push("```diff", diff, "```");
  }
  lines.push("</review_comment>");

  return lines.join("\n");
}

function normalizePromptComments(
  comments: ReviewCommentPromptComment | ReadonlyArray<ReviewCommentPromptComment>,
): ReadonlyArray<ReviewCommentPromptComment> {
  const list = Array.isArray(comments) ? comments : [comments];
  return list.filter((comment) => comment.text.trim().length > 0);
}

function buildReviewCommentPrompt(
  instruction: string,
  comments: ReviewCommentPromptComment | ReadonlyArray<ReviewCommentPromptComment>,
): string {
  const blocks = normalizePromptComments(comments).map(serializeReviewCommentBlock);
  return [instruction, "Do not make unrelated refactors.", ...blocks].join("\n\n");
}

export function buildFixSelectedReviewCommentsPrompt(
  comments: ReviewCommentPromptComment | ReadonlyArray<ReviewCommentPromptComment>,
): string {
  return buildReviewCommentPrompt(
    "Apply the smallest necessary changes in the current worktree to resolve the selected review comment(s).",
    comments,
  );
}

export function buildFixSelectedReviewCommentPrompt(
  comments: ReviewCommentPromptComment | ReadonlyArray<ReviewCommentPromptComment>,
): string {
  return buildFixSelectedReviewCommentsPrompt(comments);
}

export function buildFixAllReviewCommentsPrompt(
  comments: ReadonlyArray<ReviewCommentPromptComment>,
): string {
  return buildReviewCommentPrompt(
    "Apply the smallest necessary changes in the current worktree to resolve all review comments below.",
    comments,
  );
}

export function buildFixAllReviewCommentPrompt(
  comments: ReadonlyArray<ReviewCommentPromptComment>,
): string {
  return buildFixAllReviewCommentsPrompt(comments);
}
