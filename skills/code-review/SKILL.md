---
name: code-review
description: Use when the user wants code reviewed, refactored, or improved. Triggers include requests for code review, code quality analysis, refactoring suggestions, performance optimization, security audit, bug finding, or best practices evaluation. Also use for architecture review, design pattern suggestions, and technical debt assessment.
tools:
  - file_read
  - file_edit
  - grep
  - glob
  - code_execution
---

# Code Review and Refactoring

## Overview
Perform thorough code reviews focusing on correctness, security, performance, maintainability, and best practices. Provide actionable feedback with specific improvement suggestions.

## Review Checklist

### Correctness
- Logic errors and edge cases
- Off-by-one errors in loops and ranges
- Null/undefined handling
- Error handling completeness
- Race conditions in async code
- State management consistency

### Security
- Input validation and sanitization
- SQL injection / XSS / CSRF vulnerabilities
- Authentication and authorization checks
- Sensitive data exposure (logs, error messages)
- Dependency vulnerabilities
- Secrets in code or config

### Performance
- N+1 query patterns
- Unnecessary re-renders (React)
- Missing memoization for expensive operations
- Unbounded data structures
- Missing pagination or limits
- Inefficient algorithms (quadratic loops)

### Maintainability
- Code duplication (DRY violations)
- Function/method length (prefer under 30 lines)
- Naming clarity
- Separation of concerns
- Test coverage gaps
- Documentation for complex logic

### Type Safety (TypeScript)
- Proper use of types vs `any`
- Discriminated unions for state
- Exhaustive switch statements
- Proper generic constraints
- Null-safe property access

## Review Output Format

For each issue found, provide:

1. **Severity**: Critical / Warning / Suggestion
2. **Location**: File path and line number
3. **Issue**: Clear description of the problem
4. **Impact**: What could go wrong
5. **Fix**: Specific code suggestion

Example:
```
[Critical] src/auth.ts:45
Issue: Password compared with === instead of timing-safe comparison
Impact: Vulnerable to timing attacks
Fix: Use crypto.timingSafeEqual() for password comparison
```

## Refactoring Patterns

### Extract Function
When a code block does one coherent thing, extract it:
```typescript
// Before
if (user.age >= 18 && user.hasId && !user.isBanned) { ... }

// After
function isEligible(user: User): boolean {
  return user.age >= 18 && user.hasId && !user.isBanned;
}
```

### Replace Conditionals with Polymorphism
```typescript
// Before: switch on type
switch (shape.type) {
  case 'circle': return Math.PI * shape.radius ** 2;
  case 'square': return shape.side ** 2;
}

// After: each shape knows its area
interface Shape { area(): number; }
class Circle implements Shape { area() { return Math.PI * this.radius ** 2; } }
```

### Simplify Complex Conditionals
```typescript
// Before
if (a && (b || (c && !d)) && (e || f)) { ... }

// After
const isValid = a && hasPermission;
const hasPermission = b || (c && !d);
const isEnabled = e || f;
if (isValid && isEnabled) { ... }
```

## Best Practices
- Read the full context before making suggestions
- Prioritize issues by impact (critical bugs first)
- Suggest specific code changes, not vague advice
- Consider the project's existing patterns and conventions
- Don't nitpick style issues if there's a formatter configured
- Focus on behavior-affecting changes over cosmetic ones
- Test your refactoring suggestions mentally for correctness
