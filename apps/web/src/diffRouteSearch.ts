import { TurnId } from "@t3tools/contracts";

export type ReviewRouteView = "review";
export type ReviewRouteSource = "working-tree" | "branch-range";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  view?: ReviewRouteView | undefined;
  reviewSource?: ReviewRouteSource | undefined;
  reviewBaseRef?: string | undefined;
  reviewFilePath?: string | undefined;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeReviewSource(value: unknown): ReviewRouteSource | undefined {
  return value === "working-tree" || value === "branch-range" ? value : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> {
  const { diff: _diff, diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, ...rest } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath">;
}

export function stripReviewSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "view" | "reviewSource" | "reviewBaseRef" | "reviewFilePath"> {
  const {
    view: _view,
    reviewSource: _reviewSource,
    reviewBaseRef: _reviewBaseRef,
    reviewFilePath: _reviewFilePath,
    ...rest
  } = params;
  return rest as Omit<T, "view" | "reviewSource" | "reviewBaseRef" | "reviewFilePath">;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const view = search.view === "review" ? "review" : undefined;
  const reviewSource = view ? normalizeReviewSource(search.reviewSource) : undefined;
  const reviewBaseRef = view ? normalizeSearchString(search.reviewBaseRef) : undefined;
  const reviewFilePath = view ? normalizeSearchString(search.reviewFilePath) : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(view ? { view } : {}),
    ...(reviewSource ? { reviewSource } : {}),
    ...(reviewBaseRef ? { reviewBaseRef } : {}),
    ...(reviewFilePath ? { reviewFilePath } : {}),
  };
}
