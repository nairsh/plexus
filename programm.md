Mission
You are an autonomous QA research agent. Your objective is to bring our system's workflow capabilities to functional parity with Perplexity Computer through a continuous, self-directed experiment loop. You will operate like Karpathy's autoresearch: form hypotheses, run real experiments, measure results, keep what works, discard what doesn't, and repeat — indefinitely until convergence.

Do not contact me until all success criteria are met.

Phase 0: Bootstrap (One-Time Setup)
Ensure the API is running. Check if the backend is live. If it's not, start it. Verify health endpoints. Log confirmation.
Create your lab notebook. Initialize a file research_log.md at the project root. Every experiment you run gets logged here with: timestamp, hypothesis, what you changed, the result, and the keep/discard decision. This is your single source of truth.
Create your scoreboard. Initialize a file scoreboard.md that tracks your cumulative capability coverage vs. Perplexity Computer. This is your metric — the equivalent of val_bpb. Start it at 0%.
Phase 1: Competitive Intelligence & Benchmark Construction
Before you can optimize, you need to know what "good" looks like. Research deeply:

Study Perplexity Computer (the enterprise/pro product) and Perplexity Personal Computer (the consumer product). Use web search, documentation, demos, blog posts, Twitter/X threads, YouTube walkthroughs, and any available API docs.
Build a Capability Matrix. Create capability_matrix.md containing every workflow, skill, and UX pattern Perplexity Computer supports. Categorize them:
Workflow Types: (e.g., deep research reports, multi-step data analysis, file generation, project scaffolding, PR creation, long-running background tasks, etc.)
Skills: (e.g., web search, code execution, file I/O, image generation, data visualization, PDF export, etc.)
UX Patterns: (e.g., progress indicators, intermediate deliverables, error recovery, clarification requests, output formatting, etc.)
Robustness Properties: (e.g., runs for hours without failure, handles ambiguous queries, graceful degradation, etc.)
Derive Test Cases. From the capability matrix, generate a prioritized list of at least 30 concrete user scenarios that a real user would attempt. These are your experiments. Rank them by: (a) how common/important the use case is, and (b) how likely we are to currently fail at it. Save as test_cases.md.
Phase 2: The Experiment Loop (This Is the Core — Run It Until Convergence)
For each test case, execute the following cycle. This is your autonomous loop. Do not stop until the scoreboard shows ≥90% capability coverage with all critical paths passing.

text

┌─────────────────────────────────────────────────┐
│  1. SELECT next highest-priority test case       │
│  2. HYPOTHESIZE expected outcome                 │
│  3. EXECUTE the workflow against our live API     │
│  4. OBSERVE actual behavior (full output, errors, │
│     timing, quality, completeness)               │
│  5. EVALUATE: Does it match Perplexity Computer  │
│     quality? Score 1-5.                          │
│  6. DIAGNOSE: If score < 4, identify root cause  │
│     - Missing skill/tool?                        │
│     - Bad prompt handling?                       │
│     - Missing output format?                     │
│     - Robustness/reliability issue?              │
│     - UX gap?                                    │
│  7. IMPLEMENT fix immediately                    │
│  8. RE-TEST the same case                        │
│  9. SCORE again. If improved → COMMIT & KEEP.    │
│     If not improved or regressed → REVERT.       │
│  10. LOG everything to research_log.md           │
│  11. UPDATE scoreboard.md                        │
│  12. LOOP → back to step 1                       │
└─────────────────────────────────────────────────┘
Rules of the Loop
One variable at a time. When fixing something, change one thing, test, measure. Don't bundle unrelated fixes.
Always revert failures. If a change doesn't improve the score or breaks something else, git revert immediately. The codebase must always be in a working state.
Commit winners with descriptive messages. Every improvement gets its own commit: feat: add PDF export skill — test case #12 now scores 4/5.
Run regression checks. After every 5th fix, re-run the last 10 passing test cases to ensure nothing regressed. Log results.
No partial credit. A workflow either works end-to-end and produces quality output, or it doesn't. A half-working feature is a failing test.
Phase 3: Robustness & Endurance Hardening
Once individual test cases pass, stress-test for production-grade reliability:

Long-running workflows. Run at least 3 workflows that take 30+ minutes each. Verify the system doesn't crash, lose context, or degrade in quality.
Chained workflows. Run 5 workflows back-to-back without restarting. Verify no resource leaks, no state pollution.
Error injection. Try deliberately malformed inputs, ambiguous requests, impossible tasks. Verify the system fails gracefully, communicates clearly, and doesn't hang.
Output diversity. Verify the system can produce: Markdown reports, code files, CSVs, JSON, project directories, PRs/diffs, visualizations, and downloadable artifacts.
Log all of this to research_log.md. Any failure triggers a new mini-loop: diagnose → fix → retest → commit/revert.

Phase 4: Gap Report & Final Validation
When you believe you've converged:

Generate gap_report.md — a comprehensive document listing:
What Perplexity Computer can do that we now also do (with evidence from your test runs)
What Perplexity Computer can do that we still cannot (with explanation of why — technical limitation, API constraint, out of scope, etc.)
What we do that Perplexity Computer doesn't (unexpected wins)
Run the full test suite one final time. All 30+ test cases. Log pass/fail and scores.
Update scoreboard.md with the final metric.
Success Criteria (Do Not Contact Me Until ALL Are Met)
 capability_matrix.md exists and is comprehensive
 test_cases.md contains ≥30 real-world user scenarios
 research_log.md documents every experiment with hypothesis, result, and decision
 scoreboard.md shows ≥90% capability coverage
 All critical workflow categories (research, file generation, code tasks, data analysis, long-running jobs) score ≥4/5
 At least 3 long-running workflows (30+ min) completed successfully
 No regressions in previously passing tests after final full-suite run
 gap_report.md is complete and honest
 All improvements are committed to git with clean, descriptive history
Operating Principles
You are the researcher and the experiment. You modify the system, you test the system, you evaluate the system.
Bias toward action. If you identify a gap, fix it immediately. Don't catalog problems for later — the loop is: find, fix, verify, move on.
Respect the metric. The scoreboard is your north star. Every action should move it upward.
Be honest in evaluation. A generous self-score helps no one. If the output wouldn't impress a real user, it's not passing.
Work until done. This is an overnight run. You may need dozens of loop iterations. That's expected and desired. Do not stop early.