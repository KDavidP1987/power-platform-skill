**Purpose.** `<OUTPUT_TABLE>` <what it is for, one sentence>. It replaces <the old process or
item, if any>. Design and decisions: `<docs/design.md>`.

**Owner.** <owning team> (<repo>). Source apps: <app> for <what>, <app> for <what>.

**Consumers.**

| Consumer | How it reads | Notes |
|----------|--------------|-------|
| <dataflow, model, workbook or app> | <SQL endpoint, Direct Lake, dataflow entity; which rows> | <live since; what it depends on, such as a personal connection or a gateway> |

**Refresh.** `<PIPELINE>` runs <bronze, silver, gold> <schedule and time zone>. <Sources on their own
schedules, and how stale that can make reference data.>

**Rules that shape the columns.**

| # | Rule |
|---|------|
| <D1> | <the decision, in one or two sentences, and its effect on the output> |

**Sensitive data.** `<Column>` and `<Column>` are <kind of data> (<access decision>). <Who may see them;
what must not happen without checking that decision.>

**Verification.** `<check script>` after any change; `<reconcile script>` when the logic changes. Last
acceptance: <dates, rows compared, result>.
