---
name: pdf
description: Use when the user wants to create, read, extract text or tables from, merge, split, rotate, watermark, encrypt, or process PDF files. Triggers include any mention of .pdf files or requests to produce PDF documents. Also use for filling PDF forms, OCR on scanned PDFs, extracting images from PDFs, and converting content into professional PDF reports with charts, tables, and formatting.
tools:
  - code_execution
  - file_write
  - file_read
  - bash
---

# PDF Processing and Creation

## Overview
Create, read, and manipulate PDF files using Python libraries. Always save output files to the workspace for user download.

## Creating PDFs with reportlab

```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors

doc = SimpleDocTemplate("report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = []

# Title
story.append(Paragraph("Report Title", styles['Title']))
story.append(Spacer(1, 12))

# Body content
story.append(Paragraph("Content here. " * 20, styles['Normal']))

# Table
data = [['Header 1', 'Header 2'], ['Cell 1', 'Cell 2']]
t = Table(data)
t.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), colors.grey),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
    ('GRID', (0, 0), (-1, -1), 1, colors.black),
]))
story.append(t)

doc.build(story)
```

## Reading PDFs

### Extract text
```python
from pypdf import PdfReader

reader = PdfReader("document.pdf")
for page in reader.pages:
    print(page.extract_text())
```

### Extract tables
```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            for row in table:
                print(row)
```

## Merge PDFs
```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)
with open("merged.pdf", "wb") as output:
    writer.write(output)
```

## Split PDF
```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

## Password Protection
```python
from pypdf import PdfWriter, PdfReader

reader = PdfReader("input.pdf")
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
writer.encrypt("userpassword")
with open("encrypted.pdf", "wb") as output:
    writer.write(output)
```

## Critical Rules
- Never use Unicode subscript/superscript characters in reportlab (they render as black boxes)
- Use reportlab XML tags: `<sub>` for subscripts, `<super>` for superscripts
- Always save files to workspace for download
- Use `pypdf` for reading/merging, `reportlab` for creating, `pdfplumber` for table extraction

## Dependencies
- `pip install pypdf reportlab pdfplumber`
