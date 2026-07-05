import {useState, type FormEvent} from 'react';
import {Navigate, useNavigate} from 'react-router-dom';
import {useAuth} from '../auth/useAuth';
import {ApiError} from '../api/client';

export function Login(): JSX.Element {
    const {user, loading, login} = useAuth();
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // Already signed in → leave the login screen. RequireAuth will route a
    // forced-change session onward to /change-password.
    if (!loading && user) {
        return <Navigate to="/" replace />;
    }

    async function onSubmit(event: FormEvent): Promise<void> {
        event.preventDefault();
        setError(null);
        setSubmitting(true);
        try {
            await login(email, password);
            navigate('/', {replace: true});
        } catch (err) {
            // Surface the server's generic message; avoid leaking which field
            // was wrong.
            const message =
                err instanceof ApiError && err.status === 401
                    ? 'Invalid email or password'
                    : 'Something went wrong. Please try again.';
            setError(message);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="flex h-full items-center justify-center bg-canvas px-4">
            <form
                onSubmit={onSubmit}
                className="w-full max-w-sm space-y-5 rounded-card border border-border bg-surface p-8 shadow-card"
            >
                <div>
                    <h1 className="font-display text-2xl font-semibold text-foreground">Toprope</h1>
                    <p className="mt-1 text-sm text-muted">Sign in to your account</p>
                </div>

                {error ? (
                    <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                        {error}
                    </p>
                ) : null}

                <label className="block space-y-1">
                    <span className="text-sm font-medium text-foreground">Email</span>
                    <input
                        type="email"
                        autoComplete="username"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
                    />
                </label>

                <label className="block space-y-1">
                    <span className="text-sm font-medium text-foreground">Password</span>
                    <input
                        type="password"
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
                    />
                </label>

                <button
                    type="submit"
                    disabled={submitting}
                    className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                    {submitting ? 'Signing in…' : 'Sign in'}
                </button>
            </form>
        </div>
    );
}
