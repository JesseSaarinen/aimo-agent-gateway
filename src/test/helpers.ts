// Shared by the tests: the demo identities and a few ready-made baskets.
import { expect } from "vitest";
import { authenticate, demoKeys, type Caller } from "@/lib/agents";
import { listAudit } from "@/lib/audit";
import { requestOffer, type OfferRequest } from "@/lib/offers";
import { Refusal, type RuleId } from "@/lib/rules";
import { MONDAY } from "./setup";

export const agent = () => authenticate(demoKeys().agent) as Caller;
export const otherAgent = () => authenticate(demoKeys().secondAgent) as Caller;
export const purchaser = () => authenticate(demoKeys().purchaser) as Caller;
export const supplier = () => authenticate(demoKeys().supplier) as Caller;

/** 1,000 l of lactose-free milk as a Stock product: 200 boxes of 5 x 1 l, 1,690.00 EUR. */
export const MILK = { productId: "465039", amount: 1000, unit: "L" };

export const offerFor = (lines: OfferRequest["lines"], extra: Partial<OfferRequest> = {}, caller: Caller = agent()) =>
  requestOffer(caller, { deliverySite: "helsinki", deliveryDate: MONDAY, lines, ...extra });

/** Assert that a call is refused under a given rule, and that the refusal is in the audit log. Returns the audit entry. */
export async function expectRefusal(attempt: Promise<unknown>, rule: RuleId, http?: number) {
  const error = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "the call should have been refused").toBeInstanceOf(Refusal);
  const refusal = error as Refusal;
  expect(refusal.rule).toBe(rule);
  if (http) expect(refusal.http).toBe(http);
  expect(refusal.toJSON()).toMatchObject({ status: "refused", rule, final: true });
  const entry = (await listAudit()).find((e) => e.id === refusal.auditId);
  expect(entry, "the refusal should be in the audit log").toMatchObject({ outcome: "refused", rule, reason: refusal.reason });
  return entry!;
}
