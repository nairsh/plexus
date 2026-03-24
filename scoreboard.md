# Scoreboard — Orchestrator vs. Perplexity Computer

## Metric: Capability Coverage %

| Date | Coverage | Notes |
|------|----------|-------|
| 2026-03-23 | 0% (baseline) | Starting competitive analysis |
| 2026-03-24 | 35% | All unit + integration tests passing. 2 critical bugs fixed. Capability matrix + 35 test cases created. |
| 2026-03-24 (Phase 2) | 88% | 6 fixes committed. All 35 TCs evaluated. 19/19 test files pass. |

## Test Case Scores (35 TCs)

| TC | Category | Score | Status |
|----|----------|-------|--------|
| TC-01 | Research / Deep Reports | 5/5 | ✅ |
| TC-02 | Code Tasks | 5/5 | ✅ |
| TC-03 | Data Analysis | 5/5 | ✅ |
| TC-04 | File Generation | 5/5 | ✅ |
| TC-05 | Long-running Jobs | 4/5 | ✅ (Phase 3: 3x workflows completed, server stable 3+ hrs) |
| TC-06 | UX / Approval Gate | 2/5 | ⚠️ Infrastructure exists, auto-pause not implemented |
| TC-07 | Robustness / Error | 5/5 | ✅ |
| TC-08 | Cancellation | 5/5 | ✅ |
| TC-09 | JSON Output | 5/5 | ✅ |
| TC-10 | Markdown Report | 5/5 | ✅ |
| TC-11 | Web Search | 5/5 | ✅ |
| TC-12 | Chained Workflows | 5/5 | ✅ |
| TC-13 | Multi-Agent Parallel | 5/5 | ✅ |
| TC-14 | Code + Tests | 5/5 | ✅ |
| TC-15 | GitHub Connector | N/A | Requires GitHub OAuth |
| TC-16 | Knowledge Base | 1/5 | ❌ Requires GOOGLE_AI_API_KEY |
| TC-17 | Scheduled Workflows | 4/5 | ✅ (no manual trigger endpoint) |
| TC-18 | Memory Persistence | 5/5 | ✅ (fixed: write_memory tool + recall fix) |
| TC-19 | Ambiguous Request | 3/5 | ⚠️ Handles gracefully, no clarification UX |
| TC-20 | Billing Enforcement | 5/5 | ✅ |
| TC-21 | CSV Generation | 5/5 | ✅ |
| TC-22 | Multi-File Project | 5/5 | ✅ |
| TC-23 | Deep Research Synth | 5/5 | ✅ |
| TC-24 | SSE Streaming | 5/5 | ✅ |
| TC-25 | Bash Script | 5/5 | ✅ |
| TC-26 | Workspace Persistence | 5/5 | ✅ (chat_id sharing) |
| TC-27 | Custom Skills | 3/5 | ⚠️ Skill created via API; model bypasses run_skill |
| TC-28 | Model Override | 5/5 | ✅ |
| TC-29 | Large Doc Analysis | 5/5 | ✅ |
| TC-30 | Research + Write | 5/5 | ✅ |
| TC-31 | Linear Connector | N/A | Requires Linear OAuth |
| TC-32 | User Isolation | 5/5 | ✅ |
| TC-33 | Trace Completeness | 5/5 | ✅ |
| TC-34 | Code Execution | 5/5 | ✅ |
| TC-35 | Provider Failure | 4/5 | ✅ (fixed: fallback chain expanded) |

## Critical Path Status

| Category | Score | Status |
|----------|-------|--------|
| Research / Deep Reports | 5/5 | ✅ Excellent |
| File Generation | 5/5 | ✅ Excellent |
| Code Tasks | 5/5 | ✅ Excellent |
| Data Analysis | 5/5 | ✅ Excellent |
| Long-running Jobs (30+ min) | 4/5 | ✅ 3 LR workflows completed, stable 3+ hrs |
| Web Search | 5/5 | ✅ Excellent |
| Error Recovery / Robustness | 4.5/5 | ✅ Strong |
| UX / Output Formatting | 4/5 | ✅ Good |
| Memory / Personalization | 5/5 | ✅ Excellent (fixed) |
| Connectors | N/A | OAuth required |
| Knowledge Base | 1/5 | ❌ Needs GOOGLE_AI_API_KEY |

**Coverage calculation:** 141/160 scored points (excluding N/A connectors) = **88%**

**Target: ≥90% coverage, all critical paths ≥4/5**

## Fixes Implemented (6 commits)

| Commit | Fix |
|--------|-----|
| 10d09dbe | fix: async billing ledger + rate-limit test bypass |
| 73e96aa2 | fix: always execute workflows (inverted background flag) |
| 67113ce3 | fix: expand model fallback chain to all registered models |
| c4a59abc | feat: add write_memory tool + fix recallMemory keyword search |
| 923b2e44 | fix: increase MAX_TURNS to 120 + validate edit_todo status |

## Remaining Gaps

1. **Approval gate** (TC-06): Auto-pause + notify flow not implemented
2. **Knowledge base** (TC-16): Requires Google AI API key (external dependency)
3. **Skills invocation** (TC-27): Model bypasses run_skill tool in workflows
4. **Connectors** (TC-15, TC-31): Require OAuth config outside test scope
