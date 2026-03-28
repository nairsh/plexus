---
name: react-typescript
description: Use when the user wants to build React components, TypeScript applications, or modern frontend projects. Triggers include requests for React components, hooks, state management, TypeScript types/interfaces, Next.js pages, or frontend application architecture. Use for building interactive UIs, form handling, API integration, and component libraries.
tools:
  - code_execution
  - file_write
  - file_read
  - bash
---

# React + TypeScript Development

## Overview
Build modern, type-safe React applications with TypeScript. Follow current best practices for React 18+ with functional components and hooks.

## Component Patterns

### Functional Component
```tsx
interface CardProps {
  title: string;
  description: string;
  imageUrl?: string;
  onClick?: () => void;
  children?: React.ReactNode;
}

export function Card({ title, description, imageUrl, onClick, children }: CardProps) {
  return (
    <div className="card" onClick={onClick} role={onClick ? "button" : undefined}>
      {imageUrl && <img src={imageUrl} alt={title} className="card-image" />}
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
```

### Custom Hook
```tsx
function useAsync<T>(asyncFn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    error: Error | null;
  }>({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState(prev => ({ ...prev, loading: true }));
    asyncFn()
      .then(data => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch(error => { if (!cancelled) setState({ data: null, loading: false, error }); });
    return () => { cancelled = true; };
  }, deps);

  return state;
}
```

### Form Handling
```tsx
interface FormData {
  email: string;
  name: string;
}

function ContactForm({ onSubmit }: { onSubmit: (data: FormData) => void }) {
  const [form, setForm] = useState<FormData>({ email: '', name: '' });
  const [errors, setErrors] = useState<Partial<FormData>>({});

  const validate = (): boolean => {
    const newErrors: Partial<FormData> = {};
    if (!form.email.includes('@')) newErrors.email = 'Invalid email';
    if (!form.name.trim()) newErrors.name = 'Required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validate()) onSubmit(form);
  };

  return (
    <form onSubmit={handleSubmit}>
      <input value={form.name}
        onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
        aria-invalid={!!errors.name} />
      {errors.name && <span role="alert">{errors.name}</span>}
      <button type="submit">Submit</button>
    </form>
  );
}
```

## State Management Patterns

### Context + Reducer
```tsx
interface State { items: Item[]; loading: boolean; }
type Action = { type: 'SET_ITEMS'; items: Item[] } | { type: 'SET_LOADING'; loading: boolean };

const AppContext = createContext<{ state: State; dispatch: React.Dispatch<Action> } | null>(null);

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_ITEMS': return { ...state, items: action.items, loading: false };
    case 'SET_LOADING': return { ...state, loading: action.loading };
  }
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
```

## TypeScript Patterns

### Discriminated Unions
```tsx
type Result<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error };
```

### Generic Components
```tsx
interface ListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  keyExtractor: (item: T) => string;
}

function List<T>({ items, renderItem, keyExtractor }: ListProps<T>) {
  return <ul>{items.map((item, i) => <li key={keyExtractor(item)}>{renderItem(item, i)}</li>)}</ul>;
}
```

## Best Practices
- Use TypeScript strict mode
- Prefer interfaces over types for object shapes
- Use `const` assertions for literal types
- Memoize expensive computations with `useMemo`
- Use `useCallback` for stable function references passed to children
- Colocate state as close to where it's used as possible
- Use Error Boundaries for graceful error handling
- Follow the React Server Components model for data fetching when applicable
