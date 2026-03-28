---
name: docx
description: Use when the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include any mention of Word doc, word document, .docx, or requests for professional documents with formatting like tables of contents, headings, page numbers. Also use for extracting content from .docx files, performing find-and-replace, or converting content into a polished Word document. Use for reports, memos, letters, or templates as Word files.
tools:
  - code_execution
  - file_write
  - file_read
  - bash
---

# DOCX Creation, Editing, and Analysis

## Overview
A .docx file is a ZIP archive containing XML files. Generate .docx files with JavaScript using the `docx` npm package, then deliver as a downloadable file.

## Creating New Documents

Install and use the `docx` package:

```javascript
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        ImageRun, Header, Footer, AlignmentType, PageOrientation, LevelFormat,
        ExternalHyperlink, TableOfContents, HeadingLevel, BorderStyle,
        WidthType, ShadingType, PageNumber, PageBreak } = require('docx');
const fs = require('fs');

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 24 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal",
        quickFormat: true,
        run: { size: 32, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal",
        quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 } },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    headers: {
      default: new Header({ children: [new Paragraph({ children: [new TextRun("Header")] })] })
    },
    footers: {
      default: new Footer({ children: [new Paragraph({
        children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] })]
      })] })
    },
    children: [/* content paragraphs */]
  }]
});

Packer.toBuffer(doc).then(buffer => fs.writeFileSync("document.docx", buffer));
```

## Critical Rules
- Set page size explicitly (default is A4, use US Letter 12240x15840 DXA)
- Never use `\n` — use separate Paragraph elements
- Never use unicode bullets — use LevelFormat.BULLET with numbering config
- PageBreak must be inside a Paragraph
- ImageRun requires `type` parameter (png, jpg, etc.)
- Tables need dual widths: `columnWidths` on table AND `width` on each cell
- Use WidthType.DXA (never PERCENTAGE)
- Use ShadingType.CLEAR (never SOLID) for table shading
- TOC requires HeadingLevel only

## Lists
```javascript
numbering: {
  config: [{
    reference: "bullets",
    levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022",
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
  }]
}
// Use: new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [...] })
```

## Tables
```javascript
new Table({
  width: { size: 9360, type: WidthType.DXA },
  columnWidths: [4680, 4680],
  rows: [new TableRow({ children: [
    new TableCell({
      borders: { top: border, bottom: border, left: border, right: border },
      width: { size: 4680, type: WidthType.DXA },
      shading: { fill: "D5E8F0", type: ShadingType.CLEAR },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun("Cell")] })]
    })
  ]})]
})
```

## File Delivery
Always save the .docx file to the workspace so users can download it. Use `fs.writeFileSync()` to write the buffer to a file path in the workspace.

## Dependencies
- `npm install docx` (for creating new documents)
