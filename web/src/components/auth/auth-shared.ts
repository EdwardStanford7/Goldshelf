import { signIn, signUp } from '@/lib/auth-client';

/*
 * Shared building blocks for the auth routes. The sign-in and sign-up pages are
 * separate components (SignInForm / SignUpForm); this module holds only what
 * they genuinely have in common: presentation constants, the better-auth API
 * calls, and error normalization.
 */

export const FORM_CLASS = 'grid gap-[0.95rem]';
export const FIELD_CLASS = 'grid gap-[0.4rem] text-[0.92rem] font-bold text-muted-foreground';
export const FIELD_INPUT_CLASS = 'min-h-12 font-medium';
export const SUBMIT_CLASS = 'mt-1 min-h-[3.15rem] w-full text-base font-extrabold';
export const STATUS_CLASS =
  'rounded-sm border-l-4 border-l-gold bg-status px-3 py-[0.6rem] whitespace-pre-line';

export type AuthOptions = {
  minPasswordLength: number;
};

export function passwordLengthMessage(minPasswordLength: number) {
  return `Use at least ${minPasswordLength} characters.\nLonger passphrases are more secure.`;
}

export function validateNewPasswordLength(password: string, minPasswordLength: number) {
  return password.length < minPasswordLength ? passwordLengthMessage(minPasswordLength) : null;
}

export async function signInWithEmail({ email, password }: { email: string; password: string }) {
  const result = await signIn.email({
    email: email.trim(),
    password,
    callbackURL: '/',
  });

  if (result.error) {
    throw new Error(result.error.message || result.error.code || 'Sign in failed');
  }
}

export async function signUpWithEmail({
  email,
  password,
  name,
}: {
  email: string;
  password: string;
  name: string;
}) {
  const result = await signUp.email({
    email: email.trim(),
    password,
    name: name.trim() || email.trim(),
    callbackURL: '/',
  });

  if (result.error) {
    throw new Error(result.error.message || result.error.code || 'Account creation failed');
  }
}

export async function requestPasswordResetEmail({ email }: { email: string }) {
  const response = await fetch('/api/auth/request-password-reset', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: email.trim(),
      redirectTo: 'https://goldshelf.net/signin',
    }),
  });

  if (!response.ok) {
    throw new Error(await readAuthError(response, 'Password reset request failed'));
  }
}

export async function resetPasswordWithToken({
  token,
  newPassword,
}: {
  token: string;
  newPassword: string;
}) {
  const response = await fetch('/api/auth/reset-password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      token,
      newPassword,
    }),
  });

  if (!response.ok) {
    throw new Error(await readAuthError(response, 'Password reset failed'));
  }
}

export async function readAuthError(response: Response, fallback: string) {
  const text = await response.text().catch(() => '');
  const body = text ? safeJsonParse(text) : null;
  if (body && typeof body === 'object') {
    if ('message' in body && typeof body.message === 'string') {
      return body.message;
    }

    if ('code' in body && typeof body.code === 'string') {
      return body.code.replaceAll('_', ' ').toLowerCase();
    }
  }

  if (text.trim()) {
    return text.trim();
  }

  return `${fallback} (${response.status})`;
}

export function formatSignInError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Authentication failed';
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('too many') || normalizedMessage.includes('rate')) {
    return 'Too many attempts. Try again later.';
  }

  return 'Email or password is incorrect.';
}

export function formatSignUpError(error: unknown, minPasswordLength: number) {
  const message = error instanceof Error ? error.message : 'Authentication failed';
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('too many') || normalizedMessage.includes('rate')) {
    return 'Too many attempts. Try again later.';
  }

  if (
    normalizedMessage.includes('password') &&
    (normalizedMessage.includes('character') ||
      normalizedMessage.includes('length') ||
      normalizedMessage.includes('short'))
  ) {
    return passwordLengthMessage(minPasswordLength);
  }

  return message;
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
