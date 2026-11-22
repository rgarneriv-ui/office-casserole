# ADR-0005: Spreadsheet calculation engine

**Status:** Accepted · 2026-11-22
**Context:** Spec §7.2 (typed calculation runtime, deterministic evaluation).

## Decision

- `engines/spreadsheet-calc` implements the §7.2 chain: tokenizer →
  precedence-climbing parser → AST → reference resolver → dependency graph →
  incremental dirty-subgraph recalculation, with observable `evalCount` so
  incrementality is provable in tests rather than asserted.
- Values are typed (`number | string | boolean | null | ErrorValue`); errors
  are first-class values that propagate through operators and non-shielding
  functions. Cycles (self-reference included) resolve to `#CYCLE!` on every
  participating cell and recover when the cycle is broken.
- Excel conventions adopted deliberately: `^` right-associative; unary minus
  binds its operand before `^` (`=-3^2` → 9); text compares case-insensitively
  and sorts above numbers; empty cells are 0 in arithmetic and skipped by
  aggregates; `%` literals divide by 100.
- Ranges are legal only as function arguments in v0; a range in arithmetic is
  `#VALUE!` (dynamic arrays/spill are a later feature, §7.2).

## Consequences

- The function registry (17 functions) is a plain table with arity checks —
  adding functions is data work, not parser work.
- Differential testing against reference implementations (§7.2 closing
  requirement) has not run; statuses stay at *tested* on our own suites.
- Volatile functions, external data, locale display, and multithreaded
  scheduling are explicitly out of the v0 engine; the dependency-graph design
  leaves room for each.
