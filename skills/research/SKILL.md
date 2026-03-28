---
name: research
description: Use when the user wants in-depth research, summarization, or analysis on any topic. Triggers include requests for research reports, literature reviews, competitive analysis, market research, topic summaries, fact-checking, or comprehensive overviews. Also use for synthesizing information from multiple sources, creating executive summaries, or producing structured research documents.
tools:
  - web_search
  - fetch_url
  - file_write
  - file_read
  - code_execution
---

# Research and Summarization

## Overview
Conduct thorough research by gathering information from multiple sources, synthesizing findings, and producing well-structured reports with citations.

## Research Process

### 1. Define Scope
- Clarify the research question
- Identify key sub-topics to cover
- Determine depth required (overview vs deep-dive)
- Identify target audience for the output

### 2. Gather Information
- Search for authoritative sources on each sub-topic
- Cross-reference claims across multiple sources
- Note publication dates for currency of information
- Identify primary sources vs commentary
- Look for official documentation, research papers, industry reports

### 3. Synthesize Findings
- Identify common themes and consensus views
- Note areas of disagreement or debate
- Distinguish between facts, opinions, and speculation
- Organize findings by theme, not by source

### 4. Produce Output
- Structure with clear headings and logical flow
- Include executive summary for long documents
- Cite sources throughout
- Highlight key takeaways and actionable insights

## Output Formats

### Research Report Structure
```markdown
# [Topic] Research Report

## Executive Summary
Brief overview of key findings (3-5 sentences).

## Background
Context and why this topic matters.

## Key Findings

### Finding 1: [Title]
Details, evidence, and analysis.
- Supporting data point
- Source citation

### Finding 2: [Title]
...

## Analysis
Synthesis of findings, patterns, implications.

## Recommendations
Actionable next steps based on findings.

## Sources
1. [Source name] - [URL] (accessed [date])
2. ...
```

### Competitive Analysis
```markdown
# Competitive Analysis: [Market/Product]

## Market Overview
Size, growth, key trends.

## Competitor Profiles

### [Competitor 1]
- **Product**: Description
- **Pricing**: Model and ranges
- **Strengths**: Key advantages
- **Weaknesses**: Gaps and limitations
- **Market position**: Share, segments

## Comparison Matrix
| Feature | Us | Comp A | Comp B |
|---------|------|--------|--------|
| Feature 1 | Yes | Yes | No |

## Strategic Implications
Opportunities and threats identified.
```

### Literature Review
```markdown
# Literature Review: [Topic]

## Methodology
Search terms, databases, inclusion criteria.

## Themes

### Theme 1: [Name]
Summary of findings across sources.
Key studies: [Author (Year)], [Author (Year)]

## Gaps in Literature
Areas needing further research.

## Conclusions
Current state of knowledge.
```

## Research Quality Standards
- Use at least 3 independent sources for key claims
- Prefer primary sources over secondary reporting
- Note when information may be outdated
- Clearly distinguish between established facts and emerging claims
- Include publication dates for all cited sources
- Flag areas of uncertainty or conflicting information

## Best Practices
- Start broad, then narrow focus based on initial findings
- Use web search for current information, not just training data
- Verify statistics and data points from original sources
- Structure output for the target audience's expertise level
- Include both quantitative data and qualitative insights
- Save research output as downloadable documents when requested
