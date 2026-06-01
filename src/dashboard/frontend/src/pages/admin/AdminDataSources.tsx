import {Card} from '../../components/Card';
import {Badge} from '../../components/Badge';
import {useAdminDataSources} from '../../hooks/useAdmin';
import {PageHeader, Table, Td, Th} from './adminUi';

function formatSync(value: string | null): string {
    if (!value) return 'never';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function StatusBadge({connected}: {connected: boolean}): JSX.Element {
    return connected ? <Badge tone="success">Connected</Badge> : <Badge tone="neutral">Not connected</Badge>;
}

/**
 * Admin → Data Sources (Task 2.13). Read-only in Phase 2: shows tool connector
 * and git provider operational status. Connector configuration stays in the
 * config file, so there are no edit controls here.
 */
export function AdminDataSources(): JSX.Element {
    const sources = useAdminDataSources();

    return (
        <div className="space-y-6">
            <PageHeader
                title="Data sources"
                description="Connector and git provider status (read-only — configuration lives in the config file)."
            />
            {sources.isPending ? (
                <Card>
                    <p className="text-sm text-muted">Loading…</p>
                </Card>
            ) : sources.isError ? (
                <Card>
                    <p className="text-sm text-danger">Failed to load: {sources.error.message}</p>
                </Card>
            ) : (
                <>
                    <Card title="Tool connectors">
                        <Table
                            head={
                                <>
                                    <Th>Connector</Th>
                                    <Th>Status</Th>
                                    <Th>Last sync status</Th>
                                    <Th>Last sync</Th>
                                </>
                            }
                        >
                            {sources.data.connectors.map((c) => (
                                <tr key={c.connector} className="border-b border-border/60">
                                    <Td>{c.connector}</Td>
                                    <Td>
                                        <StatusBadge connected={c.connected} />
                                    </Td>
                                    <Td>{c.status ?? '—'}</Td>
                                    <Td>{formatSync(c.last_sync)}</Td>
                                </tr>
                            ))}
                        </Table>
                    </Card>
                    <Card title="Git providers">
                        <Table
                            head={
                                <>
                                    <Th>Provider</Th>
                                    <Th>Status</Th>
                                    <Th>Developers with activity</Th>
                                    <Th>Last sync</Th>
                                </>
                            }
                        >
                            {sources.data.git_providers.map((p) => (
                                <tr key={p.provider} className="border-b border-border/60">
                                    <Td>{p.provider}</Td>
                                    <Td>
                                        <StatusBadge connected={p.connected} />
                                    </Td>
                                    <Td>{p.developer_count}</Td>
                                    <Td>{formatSync(p.last_sync)}</Td>
                                </tr>
                            ))}
                        </Table>
                    </Card>
                </>
            )}
        </div>
    );
}
