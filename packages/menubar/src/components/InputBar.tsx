import { useState, useRef, type KeyboardEvent } from 'react';
import { ComputerIcon } from './icons/ComputerIcon.js';

interface Props {
  onSubmit: (objective: string) => void;
  isSubmitting: boolean;
}

export function InputBar({ onSubmit, isSubmitting }: Props) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const objective = value.trim();
    if (!objective || isSubmitting) return;
    onSubmit(objective);
    setValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && value.trim() && !isSubmitting) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      setValue('');
      inputRef.current?.blur();
    }
  };

  return (
    <div className="input-shell">
      <span className="input-shell-icon" aria-hidden="true">
        <ComputerIcon className="input-shell-icon-glyph" />
      </span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={isSubmitting ? 'Starting workflow…' : 'Describe what you want done'}
        disabled={isSubmitting}
        className="input-pill"
      />
      <button className="input-submit" onClick={submit} disabled={isSubmitting || !value.trim()}>
        {isSubmitting ? '…' : 'Go'}
      </button>
    </div>
  );
}
