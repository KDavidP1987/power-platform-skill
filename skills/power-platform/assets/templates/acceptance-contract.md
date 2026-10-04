# Acceptance contract: <app or feature>

Write this before the first screen, from the request in the requester's words. It is the list of
things the published app must be seen to do. `scripts/contract-to-walk.mjs` checks that every
requirement has an action, every action a scenario and every write a Dataverse confirmation, then
writes one `canvas-browser.mjs walk` scenario skeleton per scenario row.

Rules for the tables (the script reads them; keep the headings and column order):

- Ids are short and stable: `R1`, `A1`, `X1`, `S1`. Never renumber; retire an id instead.
- Several ids in one cell are separated by commas.
- `Writes` is `none` for an action that only reads or navigates; otherwise `table: columns`.
- A `Confirms` row belongs to an action (`For` = `A..`) or a refusal (`For` = `X..`). `Expect` is
  `column=value; column=value` with the Web API column names; a refusal's row names the values that
  must be unchanged. `Count` is optional.
- `When` and `Then` are steps separated by `;`. Written as `click "Submit"`, `type "abc" into
  "Reason"`, `select "Closed"`, `expect "Saved"`, `absent "Delete"`, they become walk steps;
  anything else becomes a `todo` step that the walk lint refuses until someone writes it as a step.
- `Kind` is `success`, `refusal`, `invalid`, `boundary` or `twice` (the same action pressed twice).

## Requirements

| Id | Requirement (the request's words) | Actions |
|----|-----------------------------------|---------|
| R1 | A buyer can submit an order for approval once it has lines and a delivery date | A1 |
| R2 | An approver approves or rejects a submitted order; rejection needs a reason | A2, A3 |

## Actions

| Id | Action | Precondition | Trigger (screen > control) | Writes | Observable result |
|----|--------|--------------|----------------------------|--------|-------------------|
| A1 | Submit an order | Draft, at least one line, delivery date set | Order > Submit | app_order: app_status, app_submittedon | Status chip reads Submitted; Submit is hidden |
| A2 | Approve an order | Submitted, signed-in user is an approver | Order > Approve | app_order: app_status, app_decidedby | Status chip reads Approved |
| A3 | Reject an order | Submitted, approver, reason given | Order > Reject | app_order: app_status, app_reason | Status chip reads Rejected; reason shown |

## Refusals

| Id | Action | Refused when | Message shown |
|----|--------|--------------|---------------|
| X1 | A1 | the order has no lines | Add at least one line first. |
| X2 | A3 | the reason is empty | Give the reason for the rejection. |

## Confirms

| For | Entity set | Filter | Expect | Count |
|-----|------------|--------|--------|-------|
| A1 | app_orders | app_number eq 'ORD-0042' | app_status=Submitted | 1 |
| A2 | app_orders | app_number eq 'ORD-0043' | app_status=Approved | 1 |
| A3 | app_orders | app_number eq 'ORD-0044' | app_status=Rejected; app_reason=Wrong vendor | 1 |
| X1 | app_orders | app_number eq 'ORD-0045' | app_status=Draft | 1 |
| X2 | app_orders | app_number eq 'ORD-0046' | app_status=Submitted | 1 |

## Scenarios

| Id | Covers | Kind | Given | When | Then |
|----|--------|------|-------|------|------|
| S1 | A1 | success | ORD-0042 is Draft with two lines and a delivery date | click "ORD-0042"; click "Submit" | expect "Submitted"; absent "Submit" |
| S2 | X1 | refusal | ORD-0045 is Draft with no lines | click "ORD-0045"; click "Submit" | expect "Add at least one line first." |
| S3 | A1 | twice | ORD-0042 was just submitted | click "Submit"; click "Submit" | expect "Submitted" |
| S4 | A2 | success | ORD-0043 is Submitted; signed in as an approver | click "ORD-0043"; click "Approve" | expect "Approved" |
| S5 | A3 | success | ORD-0044 is Submitted | click "ORD-0044"; type "Wrong vendor" into "Reason"; click "Reject" | expect "Rejected"; expect "Wrong vendor" |
| S6 | X2 | refusal | ORD-0046 is Submitted | click "ORD-0046"; click "Reject" | expect "Give the reason for the rejection." |
