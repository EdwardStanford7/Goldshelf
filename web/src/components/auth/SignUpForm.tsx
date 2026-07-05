import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthLayout } from './AuthLayout';
import { PasswordField } from './PasswordField';
import {
  type AuthOptions,
  FIELD_CLASS,
  FIELD_INPUT_CLASS,
  FORM_CLASS,
  STATUS_CLASS,
  SUBMIT_CLASS,
  formatSignUpError,
  signUpWithEmail,
  validateNewPasswordLength,
} from './auth-shared';

export function SignUpForm({ authOptions }: { authOptions: AuthOptions }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    const name = String(form.get('name') ?? email);

    try {
      const passwordLengthError = validateNewPasswordLength(password, authOptions.minPasswordLength);
      if (passwordLengthError) {
        setError(passwordLengthError);
        return;
      }
      await signUpWithEmail({ email, password, name });
      window.location.assign('/');
    } catch (authError) {
      setError(formatSignUpError(authError, authOptions.minPasswordLength));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="Welcome to Goldshelf"
      title="Create account"
      description="Start building rankings that actually reflect your taste."
    >
      {error ?
        <div className={STATUS_CLASS}>{error}</div>
      : null}

      <form className={FORM_CLASS} onSubmit={handleSubmit}>
        <label className={FIELD_CLASS}>
          <span>Name</span>
          <Input className={FIELD_INPUT_CLASS} name="name" placeholder="Jane Doe" autoComplete="name" required />
        </label>
        <label className={FIELD_CLASS}>
          <span>Email</span>
          <Input
            className={FIELD_INPUT_CLASS}
            name="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
        </label>
        <PasswordField
          label="Password"
          name="password"
          placeholder={`At least ${authOptions.minPasswordLength} characters`}
          autoComplete="new-password"
          minLength={authOptions.minPasswordLength}
        />
        <Button size="lg" className={SUBMIT_CLASS} disabled={submitting} type="submit">
          {submitting ? 'Creating account...' : 'Create account'}
        </Button>
      </form>

      <p className="m-0 text-center text-muted-foreground">
        Already have an account?{' '}
        <Button className="h-auto p-0 font-extrabold" size="sm" variant="link" asChild>
          <Link to="/signin">Sign in</Link>
        </Button>
      </p>
    </AuthLayout>
  );
}
