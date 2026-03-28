---
name: html-css
description: Use when the user wants to create web pages, landing pages, email templates, or any HTML/CSS content. Triggers include requests for websites, web pages, HTML files, CSS styling, responsive layouts, email templates, or static site content. Use for building interactive web components, styled layouts, forms, dashboards, or any browser-rendered content.
tools:
  - code_execution
  - file_write
  - file_read
---

# HTML/CSS Web Development

## Overview
Create professional, responsive web pages and components using modern HTML5 and CSS3. Save output as .html files to the workspace for preview and download.

## Page Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page Title</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --primary: #2563eb;
      --primary-dark: #1d4ed8;
      --bg: #ffffff;
      --bg-subtle: #f8fafc;
      --text: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --radius: 8px;
      --shadow: 0 1px 3px rgba(0,0,0,0.1);
      --shadow-lg: 0 10px 25px rgba(0,0,0,0.1);
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: var(--text);
      background: var(--bg);
      line-height: 1.6;
    }

    .container { max-width: 1200px; margin: 0 auto; padding: 0 1.5rem; }
  </style>
</head>
<body>
  <!-- Content here -->
</body>
</html>
```

## Common Patterns

### Responsive Grid
```css
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1.5rem;
}
```

### Card Component
```css
.card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.5rem;
  box-shadow: var(--shadow);
  transition: box-shadow 0.2s;
}
.card:hover { box-shadow: var(--shadow-lg); }
```

### Hero Section
```css
.hero {
  background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
  color: white;
  padding: 6rem 2rem;
  text-align: center;
}
.hero h1 { font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 800; }
```

### Navigation
```css
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 2rem;
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0;
  background: rgba(255,255,255,0.95);
  backdrop-filter: blur(8px);
  z-index: 100;
}
```

### Button Styles
```css
.btn {
  display: inline-flex; align-items: center; gap: 0.5rem;
  padding: 0.625rem 1.25rem;
  border-radius: var(--radius);
  font-weight: 500; font-size: 0.875rem;
  cursor: pointer; border: none;
  transition: all 0.15s;
}
.btn-primary { background: var(--primary); color: white; }
.btn-primary:hover { background: var(--primary-dark); }
.btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
```

## Responsive Design
- Use `clamp()` for fluid typography
- Use CSS Grid with `auto-fit` and `minmax()` for responsive grids
- Use `max-width` with `margin: auto` for content containers
- Use media queries for breakpoints: 640px (sm), 768px (md), 1024px (lg)
- Mobile-first approach: base styles for mobile, add complexity for larger screens

## Accessibility
- Use semantic HTML elements (nav, main, section, article, footer)
- Include alt text on all images
- Use proper heading hierarchy (h1 > h2 > h3)
- Ensure color contrast ratios meet WCAG 2.1 AA (4.5:1 for text)
- Add aria-labels where needed

## Best Practices
- Use CSS custom properties for theming
- Prefer flexbox/grid over floats
- Use rem/em units for font sizes, spacing
- Keep CSS specificity low
- Always save as a complete, self-contained .html file
