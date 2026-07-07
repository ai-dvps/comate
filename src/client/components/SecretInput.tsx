import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { isSecretSet } from './bot-form-utils';

interface SecretInputProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  original: string | true | undefined;
  onChange: (value: string) => void;
  onReveal?: () => Promise<string | undefined>;
}

export default function SecretInput({ id, label, value, placeholder, original, onChange, onReveal }: SecretInputProps) {
  const [show, setShow] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [isRevealing, setIsRevealing] = useState(false);
  const isSet = isSecretSet(original) && value === '';
  const revealedOriginal = typeof original === 'string' ? original : null;
  const displayValue = value || revealed || revealedOriginal || '';

  const handleToggle = async () => {
    if (value === '' && original === true && onReveal && !revealed && !isRevealing) {
      setIsRevealing(true);
      try {
        const plaintext = await onReveal();
        if (plaintext !== undefined) {
          setRevealed(plaintext);
          setShow(true);
          return;
        }
      } finally {
        setIsRevealing(false);
      }
    }
    setShow((prev) => !prev);
  };

  return (
    <div>
      <label className="block text-[11px] font-medium text-text-tertiary mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={displayValue}
          onChange={(e) => {
            setRevealed(null);
            onChange(e.target.value);
          }}
          placeholder={isSet ? '••••••••' : placeholder}
          className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
        <button
          type="button"
          onClick={() => void handleToggle()}
          disabled={isRevealing}
          className="p-2 rounded-lg border border-border hover:bg-surface-hover text-text-tertiary transition-colors disabled:opacity-50"
        >
          {isRevealing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : show ? (
            <EyeOff className="w-4 h-4" />
          ) : (
            <Eye className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}
