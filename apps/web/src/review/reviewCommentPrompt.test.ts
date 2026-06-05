import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseReviewCommentMessageSegments } from "../reviewCommentContext";
import type { ReviewCommentAnchor } from "./reviewCommentAnchor";
import {
  buildFixAllReviewCommentsPrompt,
  buildFixSelectedReviewCommentsPrompt,
  serializeReviewCommentBlock,
} from "./reviewCommentPrompt";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-review"),
);

const fileAnchor: ReviewCommentAnchor = {
  kind: "file",
  threadRef,
  sourceId: "turn-2",
  sectionId: "section-2",
  sectionTitle: "Turn 2",
  diffHash: "hash-1",
  filePath: "apps/web/src/review/reviewCommentPrompt.ts",
  range: {
    startIndex: 4,
    endIndex: 6,
    rangeLabel: "+12 to +14",
  },
  source: {
    title: "Working tree diff",
    baseRef: "main",
    headRef: "feature/review-comments",
  },
};

describe("review comment prompt serialization", () => {
  it("serializes parser-compatible review comment blocks", () => {
    const block = serializeReviewCommentBlock({
      anchor: fileAnchor,
      text: "Please keep the prompt focused.",
      diff: ["@@ -1,1 +1,1 @@", "-old", "+new"].join("\n"),
    });

    const [segment] = parseReviewCommentMessageSegments(block);

    expect(segment?.kind).toBe("review-comment");
    if (segment?.kind !== "review-comment") return;

    expect(segment.comment).toEqual(
      expect.objectContaining({
        sectionId: "section-2",
        sectionTitle: "Turn 2",
        filePath: "apps/web/src/review/reviewCommentPrompt.ts",
        startIndex: 4,
        endIndex: 6,
        rangeLabel: "+12 to +14",
        text: "Please keep the prompt focused.",
        diff: expect.stringContaining("+new"),
      }),
    );
  });

  it("encodes folder comments while preserving web parser compatibility", () => {
    const folderAnchor: ReviewCommentAnchor = {
      kind: "folder",
      threadRef,
      sourceId: "turn-2",
      sectionId: "section-folder",
      sectionTitle: "Review",
      diffHash: "hash-1",
      folderPath: "apps/web/src/review/",
    };

    const block = serializeReviewCommentBlock({
      anchor: folderAnchor,
      text: "Apply this across the review helpers.",
    });
    const [segment] = parseReviewCommentMessageSegments(block);

    expect(block).toContain('targetKind="folder"');
    expect(block).toContain('folderPath="apps/web/src/review"');
    expect(segment?.kind).toBe("review-comment");
    if (segment?.kind !== "review-comment") return;

    expect(segment.comment.filePath).toBe("apps/web/src/review");
    expect(segment.comment.sectionTitle).toBe("Review (folder: apps/web/src/review)");
    expect(segment.comment.rangeLabel).toBe("folder");
  });

  it("builds fix selected and fix all prompts with review comment blocks", () => {
    const selectedPrompt = buildFixSelectedReviewCommentsPrompt({
      anchor: fileAnchor,
      text: "Fix this one.",
    });
    const allPrompt = buildFixAllReviewCommentsPrompt([
      { anchor: fileAnchor, text: "Fix this one." },
      {
        anchor: { ...fileAnchor, sourceId: "turn-3", diffHash: "hash-2" },
        text: "Fix this too.",
      },
    ]);

    expect(selectedPrompt).toContain("current worktree");
    expect(selectedPrompt.match(/<review_comment\b/g)).toHaveLength(1);
    expect(allPrompt.match(/<review_comment\b/g)).toHaveLength(2);
  });
});

