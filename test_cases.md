# Test Cases — Orchestrator Platform vs. Perplexity Computer Parity

*30 prioritized real-world user scenarios*
*Ranked: (A) Importance × (B) Likelihood of current failure*

---

## Priority 1: Core Workflow Quality (Most Critical)

### TC-01 — Deep Research Report
**User scenario:** "Research the competitive landscape of AI coding assistants in 2026 and write a comprehensive report with citations."
**Expected:** 1500+ word structured report with web-sourced citations, organized sections, relevant current data.
**Category:** Research / Deep Reports
**Current risk:** Medium — research agent exists but citation quality and depth unknown.

### TC-02 — Code Generation Task
**User scenario:** "Write a Python FastAPI server with JWT auth, user CRUD endpoints, and tests."
**Expected:** Complete, runnable code files created in workspace. Files verifiable via file_read.
**Category:** Code Tasks
**Current risk:** Low — code agent has file_write and bash.

### TC-03 — Multi-Step Data Analysis
**User scenario:** "Analyze this CSV data: [sample data]. Find trends, anomalies, and write a summary."
**Expected:** Written analysis with specific findings, potentially a processed output file.
**Category:** Data Analysis
**Current risk:** Medium — no visualization, but text analysis should work.

### TC-04 — Project Scaffolding
**User scenario:** "Create a new TypeScript React project with Vite, TailwindCSS, React Router, and a basic layout."
**Expected:** Full directory structure created in workspace: package.json, src/, components/, etc.
**Category:** File Generation
**Current risk:** Low — file agent + bash should handle this.

### TC-05 — Long-Running Background Research (30+ min)
**User scenario:** "Do an exhaustive research on quantum computing hardware advances in 2025-2026, covering at least 20 primary sources."
**Expected:** Workflow completes without crash, produces a thorough multi-section report.
**Category:** Long-running Jobs
**Current risk:** HIGH — no tested evidence of 30+ min stability.

### TC-06 — Workflow with Approval Gate
**User scenario:** "Analyze our codebase, propose a refactoring plan, then wait for my approval before making changes."
**Expected:** Workflow pauses at approval, resumes after `/approve` call, makes changes.
**Category:** UX / Human-in-Loop
**Current risk:** Low — approval endpoint exists.

### TC-07 — Error Recovery — Bad Input
**User scenario:** "Summarize the contents of /nonexistent/file.txt"
**Expected:** Graceful error message, workflow fails cleanly without hanging.
**Category:** Robustness
**Current risk:** Medium — unknown error propagation behavior.

### TC-08 — Workflow Cancellation
**User scenario:** Start a long workflow, then cancel it mid-run.
**Expected:** Workflow stops, status updates to cancelled, no resource leaks.
**Category:** Robustness / UX
**Current risk:** Medium — cancel mechanism exists but behavior under load unknown.

### TC-09 — Structured JSON Output
**User scenario:** "Extract all action items from this meeting transcript and return them as a JSON array with fields: task, owner, due_date."
**Expected:** Valid parseable JSON output with correct schema.
**Category:** Output Formatting
**Current risk:** Medium — no structured output enforcement.

### TC-10 — Markdown Report Generation
**User scenario:** "Write a technical spec document for a new authentication system, with sections: overview, requirements, architecture, API design, security considerations."
**Expected:** Well-structured markdown file written to workspace.
**Category:** File Generation / Write
**Current risk:** Low.

---

## Priority 2: Integration & Reliability

### TC-11 — Web Search + Synthesis
**User scenario:** "What are the latest developments in nuclear fusion energy as of early 2026?"
**Expected:** Current, accurate information synthesized from multiple web sources.
**Category:** Research / Web Search
**Current risk:** Low — Tavily integration present.

### TC-12 — Chained Workflows (5 back-to-back)
**User scenario:** Run 5 separate workflows sequentially without restarting the server.
**Expected:** All 5 complete successfully, no memory leaks, no state pollution between them.
**Category:** Robustness / Endurance
**Current risk:** Medium — no endurance testing data.

### TC-13 — Multi-Agent Subagent Parallelism
**User scenario:** "Research three topics in parallel: AI hardware, AI software frameworks, AI regulation."
**Expected:** Orchestrator spawns 3 research subagents, runs them in parallel, synthesizes results.
**Category:** Multi-Agent
**Current risk:** Low — spawn_subagent + await_subagents exist.

### TC-14 — Code + Test Generation
**User scenario:** "Write a binary search function in Python and generate unit tests for it."
**Expected:** Implementation file + test file both written. Tests should be runnable.
**Category:** Code Tasks
**Current risk:** Low.

### TC-15 — GitHub Connector — Read Repo
**User scenario:** "List all open issues in my GitHub repo and summarize the top 5 by priority."
**Expected:** GitHub connector used to fetch issues, summarized in output.
**Category:** Connectors / GitHub
**Current risk:** HIGH — connector exists but workflow integration untested.

### TC-16 — Knowledge Base — Ingest + Query
**User scenario:** "Ingest this document [sample text], then answer: What are the key takeaways?"
**Expected:** Document stored in knowledge base, retrieved and used to answer question.
**Category:** Knowledge Base
**Current risk:** Medium — knowledge API exists but RAG quality unknown.

### TC-17 — Scheduled Workflow
**User scenario:** "Every day at 9am, fetch the top AI news and send me a summary."
**Expected:** Schedule created, workflow runs on cron, produces output.
**Category:** Scheduled Jobs
**Current risk:** HIGH — schedules API exists but execution untested.

### TC-18 — Memory Persistence Across Sessions
**User scenario:** Session 1: "Remember that my preferred coding style is functional, not OOP." Session 2: "Write me a utility function."
**Expected:** Session 2 output respects the remembered preference.
**Category:** Memory / Personalization
**Current risk:** Medium — remember/recall tools exist but cross-session persistence behavior unknown.

### TC-19 — Error Injection — Ambiguous Request
**User scenario:** "Do the thing."
**Expected:** Workflow asks for clarification or fails with a helpful error, not a hang.
**Category:** Robustness / UX
**Current risk:** HIGH — no explicit clarification UX.

### TC-20 — Billing Enforcement
**User scenario:** User with 0 credits attempts to run a workflow.
**Expected:** Request rejected with 402 before workflow starts.
**Category:** Billing / Guards
**Current risk:** Low — credit precheck middleware exists.

---

## Priority 3: Output Quality & Advanced Scenarios

### TC-21 — File Generation — CSV Output
**User scenario:** "Create a CSV file with 10 rows of sample employee data: name, department, salary, hire_date."
**Expected:** Valid CSV file written to workspace, parseable.
**Category:** File Generation
**Current risk:** Low.

### TC-22 — File Generation — Multiple Files (Project)
**User scenario:** "Create a minimal Node.js Express REST API project with 3 route files and a README."
**Expected:** 5+ files created with correct structure and content.
**Category:** File Generation
**Current risk:** Low.

### TC-23 — Deep Research — Multi-Source Synthesis
**User scenario:** "Compare three competing research papers on transformer attention mechanisms and explain the key differences."
**Expected:** Fetches multiple URLs, synthesizes into coherent comparison.
**Category:** Deep Research
**Current risk:** Medium — quality dependent on model and prompt.

### TC-24 — Streaming Response Quality
**User scenario:** Submit a workflow and stream the SSE events in real-time.
**Expected:** Events arrive incrementally, step pills update progressively, final result delivered.
**Category:** UX / Streaming
**Current risk:** Low — SSE exists.

### TC-25 — Bash Tool — Complex Shell Script
**User scenario:** "Write and run a bash script that finds all .ts files in the workspace, counts lines of code, and outputs a summary."
**Expected:** Script runs, outputs correct line count data.
**Category:** Code Execution / Bash
**Current risk:** Low.

### TC-26 — Workspace Persistence
**User scenario:** Run workflow A that creates files, then run workflow B that reads those files.
**Expected:** Files created by A are accessible to B in the same workspace (chat_id).
**Category:** Workspace / Persistence
**Current risk:** Medium — workspace isolation logic exists but cross-workflow access needs testing.

### TC-27 — Skills System — Custom Skill
**User scenario:** Import a custom skill and invoke it in a workflow.
**Expected:** Skill imported via API, used by run_skill in workflow output.
**Category:** Skills
**Current risk:** Medium — skills API exists but workflow invocation path unknown.

### TC-28 — Model Preference Override
**User scenario:** Set a model preference then run a workflow — verify that model is used.
**Expected:** Response metadata shows correct model used.
**Category:** Model Routing
**Current risk:** Low.

### TC-29 — Long Context — Large Document Analysis
**User scenario:** "Analyze this 10,000-word document and extract all technical requirements."
**Expected:** Correct extraction without truncation errors.
**Category:** Robustness / Context
**Current risk:** Medium — no context window management.

### TC-30 — Multi-Tool Workflow — Research + Write
**User scenario:** "Research the history of the internet and write a 2000-word essay with proper citations."
**Expected:** Orchestrator spawns research agent (web_search), then write agent (file_write), final markdown essay.
**Category:** Multi-Agent / Multi-Tool
**Current risk:** Low — natural orchestrator workflow.

### TC-31 — Connector — Linear Issue Creation
**User scenario:** "Create a Linear issue for the bug: login button unresponsive on mobile."
**Expected:** Issue created in Linear via connector, issue ID returned.
**Category:** Connectors
**Current risk:** HIGH — connector exists but workflow tool usage untested.

### TC-32 — Concurrent User Isolation
**User scenario:** Two users run workflows simultaneously with different prompts.
**Expected:** Each user gets their own isolated workflow, no data leakage.
**Category:** Security / Multi-tenancy
**Current risk:** Low — user scoping implemented.

### TC-33 — Workflow Trace Completeness
**User scenario:** Run a multi-step workflow, then fetch the trace.
**Expected:** Trace contains all tool_call, tool_result, subagent_* events with correct timing.
**Category:** Observability
**Current risk:** Low — tracing exists.

### TC-34 — Code Execution — Python with Output
**User scenario:** "Run this Python script and tell me the output: print(sum(range(100)))"
**Expected:** Returns "4950" with working code_execution tool.
**Category:** Code Execution
**Current risk:** Medium — code_execution tool exists but sandbox invocation path needs verification.

### TC-35 — Graceful Degradation — LLM Provider Down
**User scenario:** Primary LLM provider returns 500.
**Expected:** Fallback chain kicks in, workflow continues or fails gracefully with clear error.
**Category:** Robustness
**Current risk:** Medium — fallback chain exists but behavior under provider failure unknown.

---

## Summary by Category

| Category | Test Cases | Priority |
|----------|-----------|---------|
| Research / Deep Reports | TC-01, TC-11, TC-23, TC-30 | Critical |
| Code Tasks | TC-02, TC-14, TC-25, TC-34 | Critical |
| File Generation | TC-04, TC-10, TC-21, TC-22 | High |
| Data Analysis | TC-03 | High |
| Long-running Jobs | TC-05, TC-12 | Critical |
| Multi-Agent | TC-13 | High |
| Connectors | TC-15, TC-31 | High |
| Robustness / Error Handling | TC-07, TC-08, TC-19, TC-35 | High |
| UX / Streaming | TC-06, TC-24 | Medium |
| Scheduled Jobs | TC-17 | High |
| Memory | TC-18 | Medium |
| Knowledge Base | TC-16 | High |
| Skills | TC-27 | Medium |
| Billing / Guards | TC-20 | Medium |
| Security | TC-32 | Medium |
| Observability | TC-33 | Low |
| Output Formatting | TC-09, TC-26, TC-29 | Medium |
