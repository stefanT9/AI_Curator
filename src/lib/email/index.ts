/**
 * Public surface of the email layer.
 *
 * Importing from here pulls in `send.ts`, which is "server-only".
 *
 * `sendEmail` is the only sanctioned path from this app to a mail provider.
 * Never re-export it — or anything that wraps it — from a `"use server"`
 * module: every export of one is a public endpoint, and an unauthenticated
 * caller able to name a recipient is a spam relay.
 *
 * A real caller does both: `sendEmail` is the gate and `recordSend` is the
 * record, so every attempt — delivered or refused — leaves a row behind. The
 * two are separate because `sendEmail` is database-free by design; a caller
 * that has a Supabase client is expected to hand the result straight to
 * `recordSend`, and a caller that has none (the smoke lane) simply sends.
 *
 * There is one sanctioned exception, and it is the whole of S-04:
 * `drainOutbox` sends on behalf of a database event with no session at all, so
 * it reports through `mark_email_sent` instead, which writes the same ledger
 * row from inside Postgres. See `./outbox`.
 */

export { sendEmail } from "./send";
export type { EmailMessage, SendFailure, SendResult } from "./send";

export { recordSend } from "./record";
export type { EmailLedgerClient, SendLedgerEntry } from "./record";

export { drainOutbox } from "./outbox";
export type { DrainSummary, OutboxDrainClient } from "./outbox";

export { composeOutboxEmail } from "./templates";
export type { ComposedMessage, OutboxKind, OutboxLinks } from "./templates";
