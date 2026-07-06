import {useState, type FormEvent} from 'react';
import {useNavigate} from 'react-router-dom';
import {useAuth} from '../auth/useAuth';
import {ApiError} from '../api/client';

const MIN_PASSWORD_LENGTH = 8;

export function ChangePassword(): JSX.Element {
    const {user, changePassword} = useAuth();
    const navigate = useNavigate();
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const forced = user?.must_change_password ?? false;

    async function onSubmit(event: FormEvent): Promise<void> {
        event.preventDefault();
        setError(null);

        if (newPassword.length < MIN_PASSWORD_LENGTH) {
            setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
            return;
        }
        if (newPassword !== confirm) {
            setError('New passwords do not match.');
            return;
        }

        setSubmitting(true);
        try {
            await changePassword(currentPassword, newPassword);
            navigate('/', {replace: true});
        } catch (err) {
            const message =
                err instanceof ApiError && err.status === 401
                    ? 'Current password is incorrect.'
                    : 'Could not change password. Please try again.';
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
                    <h1 className="font-display text-2xl font-semibold text-foreground">
                        Change password
                    </h1>
                    <p className="mt-1 text-sm text-muted">
                        {forced
                            ? 'You must set a new password before continuing.'
                            : 'Update your account password.'}
                    </p>
                </div>

                {error ? (
                    <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                        {error}
                    </p>
                ) : null}

                <label className="block space-y-1">
                    <span className="text-sm font-medium text-foreground">Current password</span>
                    <input
                        type="password"
                        autoComplete="current-password"
                        required
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
                    />
                </label>

                <label className="block space-y-1">
                    <span className="text-sm font-medium text-foreground">New password</span>
                    <input
                        type="password"
                        autoComplete="new-password"
                        required
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
                    />
                </label>

                <label className="block space-y-1">
                    <span className="text-sm font-medium text-foreground">Confirm new password</span>
                    <input
                        type="password"
                        autoComplete="new-password"
                        required
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
                    />
                </label>

                <button
                    type="submit"
                    disabled={submitting}
                    className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                    {submitting ? 'Saving…' : 'Change password'}
                </button>
            </form>
        </div>
    );
}
