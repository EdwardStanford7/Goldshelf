import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
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
  formatSignInError,
  requestPasswordResetEmail,
  resetPasswordWithToken,
  signInWithEmail,
  validateNewPasswordLength,
} from './auth-shared';

// The sign-in page also hosts password recovery: "Forgot password?" switches to
// the request view, and reset links from email land here with a ?token=.
type RecoveryView = 'sign-in' | 'reset-request';

export function SignInForm({ authOptions }: { authOptions: AuthOptions }) {
  const [view, setView] = useState<RecoveryView>('sign-in');
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const searchParams = new URLSearchParams(window.location.search);
    const token = searchParams.get('token');
    const resetError = searchParams.get('error');
    if (token) {
      setResetToken(token);
    } else if (resetError) {
      setError('That password reset link is invalid or expired.');
    }
  }, []);

  function clearMessages() {
    setError(null);
    setStatusMessage(null);
  }

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');

    try {
      await signInWithEmail({ email, password });
      window.location.assign('/');
    } catch (authError) {
      setError(formatSignInError(authError));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRequestPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');

    try {
      await requestPasswordResetEmail({ email });
      setStatusMessage('If that email exists, check your inbox for a reset link.');
    } catch (authError) {
      const message = authError instanceof Error ? authError.message.toLowerCase() : '';
      if (message.includes('too many') || message.includes('rate')) {
        setError('Too many attempts. Try again later.');
      } else {
        setStatusMessage('If that email exists, check your inbox for a reset link.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetToken) {
      setError('That password reset link is invalid or expired.');
      return;
    }

    clearMessages();
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get('newPassword') ?? '');
    const confirmPassword = String(form.get('confirmPassword') ?? '');
    const passwordLengthError = validateNewPasswordLength(newPassword, authOptions.minPasswordLength);
    if (passwordLengthError) {
      setError(passwordLengthError);
      setSubmitting(false);
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      setSubmitting(false);
      return;
    }

    try {
      await resetPasswordWithToken({ token: resetToken, newPassword });
      setResetToken(null);
      setStatusMessage('Password updated. Sign in with your new password.');
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', '/signin');
      }
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : 'Password reset failed');
    } finally {
      setSubmitting(false);
    }
  }

  const heading =
    resetToken ?
      {
        eyebrow: 'Account Recovery',
        title: 'Reset password',
        description: 'Choose a new password to get back to your lists.',
      }
    : view === 'reset-request' ?
      {
        eyebrow: 'Account Recovery',
        title: 'Reset password',
        description: 'Enter your email and we will send a reset link.',
      }
    : {
        eyebrow: 'Welcome Back',
        title: 'Sign in',
        description: 'Pick up where your rankings left off.',
      };

  return (
    <AuthLayout eyebrow={heading.eyebrow} title={heading.title} description={heading.description}>
      {error ?
        <div className={STATUS_CLASS}>{error}</div>
      : null}
      {statusMessage ?
        <div className={STATUS_CLASS}>{statusMessage}</div>
      : null}

      {resetToken ?
        <form className={FORM_CLASS} onSubmit={handleResetPassword}>
          <PasswordField
            label="New password"
            name="newPassword"
            placeholder={`At least ${authOptions.minPasswordLength} characters`}
            autoComplete="new-password"
            minLength={authOptions.minPasswordLength}
          />
          <PasswordField
            label="Confirm password"
            name="confirmPassword"
            placeholder="Confirm new password"
            autoComplete="new-password"
            minLength={authOptions.minPasswordLength}
          />
          <Button size="lg" className={SUBMIT_CLASS} disabled={submitting} type="submit">
            {submitting ? 'Updating...' : 'Update password'}
          </Button>
        </form>
      : view === 'reset-request' ?
        <form className={FORM_CLASS} onSubmit={handleRequestPasswordReset}>
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
          <Button size="lg" className={SUBMIT_CLASS} disabled={submitting} type="submit">
            {submitting ? 'Sending...' : 'Send reset link'}
          </Button>
        </form>
      : <form className={FORM_CLASS} onSubmit={handleSignIn}>
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
            placeholder="Password"
            autoComplete="current-password"
          />
          <Button size="lg" className={SUBMIT_CLASS} disabled={submitting} type="submit">
            {submitting ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>
      }

      {!resetToken ?
        <p className="m-0 text-center text-muted-foreground">
          {view === 'sign-in' ?
            <>
              <Button
                className="h-auto p-0 font-extrabold"
                size="sm"
                variant="link"
                type="button"
                onClick={() => {
                  clearMessages();
                  setView('reset-request');
                }}
              >
                Forgot password?
              </Button>
              <span aria-hidden="true"> · </span>
              <Button className="h-auto p-0 font-extrabold" size="sm" variant="link" asChild>
                <Link to="/signup">Create an account</Link>
              </Button>
            </>
          : <>
              Remembered it?{' '}
              <Button
                className="h-auto p-0 font-extrabold"
                size="sm"
                variant="link"
                type="button"
                onClick={() => {
                  clearMessages();
                  setView('sign-in');
                }}
              >
                Sign in
              </Button>
            </>
          }
        </p>
      : null}
    </AuthLayout>
  );
}
