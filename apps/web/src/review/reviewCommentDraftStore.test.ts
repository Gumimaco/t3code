import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createMemoryStorage } from "../lib/storage";
import type { FileReviewCommentAnchor } from "./reviewCommentAnchor";
import {
  buildReviewCommentDraftKey,
  createReviewCommentDraftStore,
} from "./reviewCommentDraftStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-review"),
);

function fileAnchor(overrides: Partial<FileReviewCommentAnchor> = {}): FileReviewCommentAnchor {
  return {
    kind: "file",
    threadRef,
    sourceId: "turn-1",
    sectionId: "section-1",
    sectionTitle: "Turn 1",
    diffHash: "diff-a",
    filePath: "src\\app.ts",
    range: {
      startIndex: 8,
      endIndex: 3,
      rangeLabel: "+10 to +15",
    },
    ...overrides,
  };
}

describe("review comment draft store", () => {
  it("builds stable keys for equivalent target paths and reversed ranges", () => {
    const first = fileAnchor();
    const second = fileAnchor({
      filePath: "src/app.ts",
      range: {
        startIndex: 3,
        endIndex: 8,
        rangeLabel: "+10 to +15",
      },
    });

    expect(buildReviewCommentDraftKey(first)).toBe(buildReviewCommentDraftKey(second));
  });

  it("does not restore a draft when the diff hash changes", async () => {
    const storage = createMemoryStorage();
    const store = createReviewCommentDraftStore(storage, {
      now: () => new Date("2026-06-05T12:00:00.000Z"),
    });
    const oldAnchor = fileAnchor({ diffHash: "old-diff" });
    const nextAnchor = fileAnchor({ diffHash: "new-diff" });

    store.setDraftText(oldAnchor, "Please keep this behavior.");

    await expect(store.getDraftText(nextAnchor)).resolves.toBeNull();
    await expect(store.getDraftText(oldAnchor)).resolves.toBe("Please keep this behavior.");
  });

  it("removes persisted drafts when text is empty", async () => {
    const storage = createMemoryStorage();
    const store = createReviewCommentDraftStore(storage);
    const anchor = fileAnchor();
    const key = store.setDraftText(anchor, "Review note");

    expect(storage.getItem(key)).not.toBeNull();

    store.setDraftText(anchor, "  ");

    expect(storage.getItem(key)).toBeNull();
    await expect(store.getDraftText(anchor)).resolves.toBeNull();
  });
});
