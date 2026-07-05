import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FIELD_CLASS, FIELD_INPUT_CLASS } from './auth-shared';

export function PasswordField({
  label,
  name,
  placeholder,
  autoComplete,
  minLength,
}: {
  label: string;
  name: string;
  placeholder: string;
  autoComplete: string;
  minLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  const inputId = useId();

  return (
    <div className={FIELD_CLASS}>
      <label htmlFor={inputId}>{label}</label>
      <span className="relative block">
        <Input
          id={inputId}
          className={`${FIELD_INPUT_CLASS} pr-12`}
          name={name}
          type={visible ? 'text' : 'password'}
          placeholder={placeholder}
          autoComplete={autoComplete}
          minLength={minLength}
          required
        />
        <Button
          aria-label={visible ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-[0.35rem] my-auto active:translate-y-0!"
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={() => setVisible((isVisible) => !isVisible)}
        >
          {visible ?
            <EyeOff />
          : <Eye />}
        </Button>
      </span>
    </div>
  );
}
