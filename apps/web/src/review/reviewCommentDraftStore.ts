import { scopedThreadKey } from "@t3tools/client-runtime";

import { createMemoryStorage, resolveStorage, type StateStorage } from "../lib/storage";
import {
  getReviewCommentTargetPath,
  normalizeReviewCommentRange,
  type ReviewCommentAnchor,
} from "./reviewCommentAnchor";

export const REVIEW_COMMENT_DRAFT_STORAGE_PREFIX = "t3code:review-comment-drafts:v1";

interface PersistedReviewCommentDraft {
  readonly version: 1;
  readonly text: string;
  readonly updatedAt: string;
  readonly diffHash: string;
  readonly sourceId: string;
  readonly targetKind: ReviewCommentAnchor["kind"];
  readonly targetPath: string;
  readonly startIndex: number | null;
  readonly endIndex: number | null;
}

export interface ReviewCommentDraft {
  readonly key: string;
  readonly text: string;
  readonly updatedAt: string;
}

export interface ReviewCommentDraftStore {
  readonly getDraft: (anchor: ReviewCommentAnchor) => Promise<ReviewCommentDraft | null>;
  readonly getDraftText: (anchor: ReviewCommentAnchor) => Promise<string | null>;
  readonly setDraftText: (anchor: ReviewCommentAnchor, text: string) => string;
  readonly removeDraft: (anchor: ReviewCommentAnchor) => void;
}

function defaultReviewCommentDraftStorage(): StateStorage {
  return resolveStorage(typeof localStorage !== "undefined" ? localStorage : createMemoryStorage());
}

function normalizeKeyPart(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Review comment draft key requires ${label}.`);
  }
  return normalized;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function getRangeKey(anchor: ReviewCommentAnchor): string {
  const range = normalizeReviewCommentRange(anchor.range);
  if (!range) {
    return "target";
  }
  return `${range.startIndex}-${range.endIndex}`;
}

export function buildReviewCommentDraftKey(anchor: ReviewCommentAnchor): string {
  const threadKey = normalizeKeyPart(scopedThreadKey(anchor.threadRef), "thread scope");
  const sourceId = normalizeKeyPart(anchor.sourceId, "source id");
  const diffHash = normalizeKeyPart(anchor.diffHash, "diff hash");
  const targetPath = normalizeKeyPart(getReviewCommentTargetPath(anchor), "target path");

  return [
    REVIEW_COMMENT_DRAFT_STORAGE_PREFIX,
    encodeKeyPart(threadKey),
    encodeKeyPart(sourceId),
    encodeKeyPart(diffHash),
    anchor.kind,
    encodeKeyPart(targetPath),
    getRangeKey(anchor),
  ].join(":");
}

function createPersistedDraft(
  anchor: ReviewCommentAnchor,
  text: string,
  updatedAt: string,
): PersistedReviewCommentDraft {
  const range = normalizeReviewCommentRange(anchor.range);
  return {
    version: 1,
    text,
    updatedAt,
    diffHash: anchor.diffHash,
    sourceId: anchor.sourceId,
    targetKind: anchor.kind,
    targetPath: getReviewCommentTargetPath(anchor),
    startIndex: range?.startIndex ?? null,
    endIndex: range?.endIndex ?? null,
  };
}

function isPersistedReviewCommentDraft(value: unknown): value is PersistedReviewCommentDraft {
  if (!value || typeof value !== "object") {
    return false;
  }

  const draft = value as Partial<PersistedReviewCommentDraft>;
  const hasNoRange = draft.startIndex === null && draft.endIndex === null;
  const hasRange = typeof draft.startIndex === "number" && typeof draft.endIndex === "number";

  return (
    draft.version === 1 &&
    typeof draft.text === "string" &&
    typeof draft.updatedAt === "string" &&
    typeof draft.diffHash === "string" &&
    typeof draft.sourceId === "string" &&
    (draft.targetKind === "file" || draft.targetKind === "folder") &&
    typeof draft.targetPath === "string" &&
    (hasNoRange || hasRange)
  );
}

function draftMatchesAnchor(draft: PersistedReviewCommentDraft, anchor: ReviewCommentAnchor): boolean {
  const range = normalizeReviewCommentRange(anchor.range);
  return (
    draft.diffHash === anchor.diffHash &&
    draft.sourceId === anchor.sourceId &&
    draft.targetKind === anchor.kind &&
    draft.targetPath === getReviewCommentTargetPath(anchor) &&
    draft.startIndex === (range?.startIndex ?? null) &&
    draft.endIndex === (range?.endIndex ?? null)
  );
}

export function createReviewCommentDraftStore(
  storage: Partial<StateStorage> | null | undefined = defaultReviewCommentDraftStorage(),
  options: { readonly now?: () => Date } = {},
): ReviewCommentDraftStore {
  const resolvedStorage = resolveStorage(storage);
  const now = options.now ?? (() => new Date());

  async function getDraft(anchor: ReviewCommentAnchor): Promise<ReviewCommentDraft | null> {
    const key = buildReviewCommentDraftKey(anchor);
    const raw = await resolvedStorage.getItem(key);
    if (!raw) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      resolvedStorage.removeItem(key);
      return null;
    }

    if (!isPersistedReviewCommentDraft(parsed) || !draftMatchesAnchor(parsed, anchor)) {
      resolvedStorage.removeItem(key);
      return null;
    }

    if (parsed.text.trim().length === 0) {
      resolvedStorage.removeItem(key);
      return null;
    }

    return {
      key,
      text: parsed.text,
      updatedAt: parsed.updatedAt,
    };
  }

  return {
    getDraft,
    async getDraftText(anchor) {
      return (await getDraft(anchor))?.text ?? null;
    },
    setDraftText(anchor, text) {
      const key = buildReviewCommentDraftKey(anchor);
      if (text.trim().length === 0) {
        resolvedStorage.removeItem(key);
        return key;
      }

      const payload = createPersistedDraft(anchor, text, now().toISOString());
      resolvedStorage.setItem(key, JSON.stringify(payload));
      return key;
    },
    removeDraft(anchor) {
      resolvedStorage.removeItem(buildReviewCommentDraftKey(anchor));
    },
  };
}

export const reviewCommentDraftStore = createReviewCommentDraftStore();
