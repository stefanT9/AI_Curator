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
 */

export { sendEmail } from "./send";
export type { EmailMessage, SendFailure, SendResult } from "./send";

export { recordSend } from "./record";
export type { EmailLedgerClient, SendLedgerEntry } from "./record";
