/**
 * Email delivery seam for surveys (Task 4.3 / #98).
 *
 * Surveys prefer the Slack bot (Task 4.2); email is the fallback when a
 * developer has no linked Slack id. Toprope has no SMTP/transport dependency
 * today, so this is a thin interface plus a logging implementation: it records
 * what would be sent and is the single place to drop in a real transport
 * (nodemailer, SES, a corporate relay) later. Tests inject a capturing fake.
 */

export interface OutboundEmail {
    to: string;
    subject: string;
    body: string;
}

export interface Emailer {
    sendEmail(message: OutboundEmail): Promise<void>;
}

/**
 * The default emailer: logs the message rather than transmitting it. Returns
 * normally (a "successful" send) so the survey is marked delivered — swap this
 * for a real transport to actually send mail. The log line is deliberately terse
 * and never includes the full body at info level to avoid leaking question text
 * into shared logs.
 */
export function createLogEmailer(
    log: (line: string) => void = (line) => console.log(line),
): Emailer {
    return {
        async sendEmail(message: OutboundEmail): Promise<void> {
            log(`[surveys][email] would send "${message.subject}" to ${message.to}`);
        },
    };
}
