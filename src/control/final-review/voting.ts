import type { FinalReviewVerdict } from "../../shared/protocol.ts";

export const REVIEW_VOTE_WINDOW = 3;

export interface ReviewVoteKey {
  sourceHash?: string;
  requirementsHash: string;
  assertionsHash: string;
}

export interface StoredReviewVote extends ReviewVoteKey {
  path: string;
  verdict: FinalReviewVerdict;
}

export interface ReviewVoteAggregate {
  verdict: FinalReviewVerdict;
  windowSize: number;
  pass: number;
  fail: number;
  priorReviewPaths: string[];
}

function isDirectional(verdict: FinalReviewVerdict): verdict is "pass" | "fail" {
  return verdict === "pass" || verdict === "fail";
}

function sameKey(candidate: StoredReviewVote, key: ReviewVoteKey): boolean {
  return Boolean(
    key.sourceHash &&
    candidate.sourceHash === key.sourceHash &&
    candidate.requirementsHash === key.requirementsHash &&
    candidate.assertionsHash === key.assertionsHash
  );
}

/**
 * Aggregate naturally occurring resubmissions without launching extra reviews.
 * History must be newest-first. UNRESOLVED is retained in its report but does
 * not cast a directional vote, and a current UNRESOLVED always fails closed.
 */
export function aggregateReviewVotes(
  key: ReviewVoteKey,
  currentVerdict: FinalReviewVerdict,
  history: StoredReviewVote[],
  windowSize = REVIEW_VOTE_WINDOW,
): ReviewVoteAggregate {
  const prior = key.sourceHash
    ? history.filter((vote) => sameKey(vote, key) && isDirectional(vote.verdict))
    : [];
  const directional = [
    ...(isDirectional(currentVerdict) ? [{ verdict: currentVerdict, path: "" }] : []),
    ...prior,
  ].slice(0, Math.max(1, windowSize));
  const pass = directional.filter((vote) => vote.verdict === "pass").length;
  const fail = directional.filter((vote) => vote.verdict === "fail").length;

  let verdict: FinalReviewVerdict = "unresolved";
  if (currentVerdict !== "unresolved") {
    if (pass > fail) verdict = "pass";
    else if (fail > pass) verdict = "fail";
  }

  return {
    verdict,
    windowSize: Math.max(1, windowSize),
    pass,
    fail,
    priorReviewPaths: directional.map((vote) => vote.path).filter(Boolean),
  };
}
