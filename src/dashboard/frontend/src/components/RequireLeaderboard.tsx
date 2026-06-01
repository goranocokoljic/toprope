import {type ReactNode} from 'react';
import {useLeaderboardAvailability} from '../hooks/useLeaderboard';
import {NotFound} from '../pages/NotFound';

/**
 * Route guard for the optional leaderboard (Task 2.17). The leaderboard ships
 * off by default and, when off, must leave NO trace — so a disabled leaderboard
 * route renders the ordinary NotFound page rather than a "disabled" notice,
 * making the URL indistinguishable from any non-existent path. While the
 * availability probe is in flight nothing is rendered (a brief blank), avoiding
 * a flash of either the board or a 404. The server still returns 403 on the data
 * endpoint regardless, so this is presentation-only defense, not the real gate.
 */
export function RequireLeaderboard({children}: {children: ReactNode}): JSX.Element {
    const {data, isPending} = useLeaderboardAvailability();
    if (isPending) {
        return <></>;
    }
    if (!data?.available) {
        return <NotFound />;
    }
    return <>{children}</>;
}
