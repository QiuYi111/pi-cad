/** Final-review submission gate: PI_CAD_FINAL_REVIEWER=1 enables cad_submit_for_review. */
export function finalReviewerEnabled(): boolean {
  const value = process.env.PI_CAD_FINAL_REVIEWER?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}
