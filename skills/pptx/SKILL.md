---
name: pptx
description: Use when creating, reading, editing, or manipulating PowerPoint presentations (.pptx files). Triggers include any mention of deck, slides, presentation, or .pptx files. Use for creating pitch decks, slide decks, extracting text from presentations, combining or splitting slide files, and working with templates, layouts, or speaker notes. If a .pptx file needs to be created or modified, use this skill.
tools:
  - code_execution
  - file_write
  - file_read
  - bash
---

# PPTX Presentation Creation

## Overview
Create professional PowerPoint presentations using the `pptxgenjs` npm package. Always save output files to the workspace for user download.

## Creating Presentations

```javascript
const pptxgen = require("pptxgenjs");
const pres = new pptxgen();

// Set default slide size (16:9)
pres.defineLayout({ name: 'CUSTOM', width: 13.33, height: 7.5 });
pres.layout = 'CUSTOM';

// Title slide
let slide = pres.addSlide();
slide.background = { color: "1E2761" };
slide.addText("Presentation Title", {
  x: 0.5, y: 2.0, w: 12.33, h: 1.5,
  fontSize: 44, bold: true, color: "FFFFFF",
  align: "center"
});
slide.addText("Subtitle text", {
  x: 0.5, y: 3.8, w: 12.33, h: 0.8,
  fontSize: 20, color: "CADCFC", align: "center"
});

// Content slide with two columns
let slide2 = pres.addSlide();
slide2.addText("Section Title", {
  x: 0.5, y: 0.3, w: 12.33, h: 0.8,
  fontSize: 36, bold: true, color: "1E2761"
});
// Left column
slide2.addText("Key points go here with supporting details.", {
  x: 0.5, y: 1.5, w: 5.5, h: 4.5,
  fontSize: 16, color: "333333", valign: "top"
});
// Right column - image or chart placeholder
slide2.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 7.0, y: 1.5, w: 5.5, h: 4.5,
  fill: { color: "F0F4F8" }, rectRadius: 0.1
});

pres.writeFile({ fileName: "presentation.pptx" });
```

## Design Principles

### Color Palettes
Choose colors that match the topic:

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| Midnight Executive | 1E2761 | CADCFC | FFFFFF |
| Forest & Moss | 2C5F2D | 97BC62 | F5F5F5 |
| Coral Energy | F96167 | F9E795 | 2F3C7E |
| Warm Terracotta | B85042 | E7E8D1 | A7BEAE |
| Ocean Gradient | 065A82 | 1C7293 | 21295C |

### Typography
| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt |

### Layout Guidelines
- Dark backgrounds for title + conclusion slides, light for content
- Every slide needs a visual element (not just text)
- 0.5" minimum margins
- Vary layouts across slides (columns, grids, callouts)
- Never use accent lines under titles (hallmark of AI slides)
- Left-align body text, center only titles

### Slide Types
- **Title slide**: Bold title, centered, dark background
- **Two-column**: Text left, visual right
- **Icon grid**: 2x2 or 2x3 cards with icons
- **Data callout**: Large stat (60-72pt) with small label
- **Timeline**: Numbered steps with connecting elements
- **Comparison**: Side-by-side columns

## Adding Charts
```javascript
slide.addChart(pres.charts.BAR, [
  { name: "Series 1", labels: ["Q1", "Q2", "Q3", "Q4"], values: [10, 20, 30, 40] }
], {
  x: 1, y: 1.5, w: 8, h: 4,
  showTitle: true, title: "Quarterly Results"
});
```

## Adding Tables
```javascript
const rows = [
  [{ text: "Header 1", options: { bold: true, fill: { color: "1E2761" }, color: "FFFFFF" } },
   { text: "Header 2", options: { bold: true, fill: { color: "1E2761" }, color: "FFFFFF" } }],
  ["Data 1", "Data 2"],
];
slide.addTable(rows, { x: 1, y: 2, w: 10, colW: [5, 5], border: { pt: 1, color: "CCCCCC" } });
```

## Critical Rules
- Always set explicit slide dimensions
- Use contrast: dark text on light backgrounds, light text on dark
- Don't repeat the same layout on every slide
- Don't create text-only slides
- Save file to workspace for download

## Dependencies
- `npm install pptxgenjs`
