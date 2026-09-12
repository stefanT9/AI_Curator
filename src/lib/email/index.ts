/**
 * Public surface of the email layer.
 *
 * Importing from here pulls in `send.ts`, which is "server-only".
 *
 * `sendEmail` is the only sanctioned path from this app to a mail provider.
 * Never re-export it — or anything that wraps it — from a `"use server"`
 * module: every export of one is a public endpoint, and an unauthenticated
 * caller able to name a recipient is a spam relay.
 */

export { sendEmail } from "./send";
export type { EmailMessage, SendFailure, SendResult } from "./send";
