import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { isSecretSet } from './bot-form-utils';

interface SecretInputProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  original: string | true | undefined;
  onChange: (value: string) => void;
}

export default function SecretInput({ label, value, placeholder, original, onChange }: SecretInputProps) {
  const [show, setShow] = useState(false);
  const isSet = isSecretSet(original) && value === '';

  return (
    <div>
      <label className="block text-[11px] font-medium text-text-tertiary mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={isSet ? '••••••••' : placeholder}
          className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
        <button
          type="button"
          onClick={() => setShow((prev) => !prev)}
          className="p-2 rounded-lg border border-border hover:bg-surface-hover text-text-tertiary transition-colors"
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
