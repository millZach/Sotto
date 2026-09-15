# Sotto membership service contract

The desktop client is implemented. A production identity service, billing account, product/price, hosted pages, and webhook deployment have **not** been configured. This document describes the endpoint the client expects; it is not evidence of a running subscription service or completed billing validation.

The installed application keeps free dictation available without an account. Any build with no membership endpoint, packaged or unpackaged, displays **Private beta** and allows agent actions; that state is not a paid entitlement. (Originally, packaged builds without an endpoint had free access only; that locked agents out of installed builds before the service existed.) Provider usage is billed through the user's chosen provider access and is not included in Sotto membership.

## HTTPS API

Configure a service origin with no path, query, or credentials. All authenticated requests carry Sotto's own bearer session; provider credentials never go to this service. The desktop rejects HTTP redirects at the API boundary.

| Method and endpoint | Request | Successful response |
| --- | --- | --- |
| `POST /v1/device/authorize` | `clientName` | `deviceCode`, `userCode`, `verificationUri`, `expiresIn` (30–900 seconds), `interval` (2–60 seconds) |
| `POST /v1/device/token` | `deviceCode` | `status: pending`, `slow_down`, `expired`, or `denied`; approval returns `status: authorized`, `accessToken`, ISO `expiresAt` |
| `GET /v1/entitlement` | Bearer session | `status: free/active/expired`, ISO/null `expiresAt`, ISO `cacheUntil`, boolean `cancelAtPeriodEnd` |
| `POST /v1/billing/checkout` | Bearer session, empty object | `url` for a newly created hosted checkout |
| `POST /v1/billing/portal` | Bearer session, empty object | `url` for a newly created hosted customer portal session |

The sign-in browser destination must use the configured service origin. Billing links must use that origin or the exact Stripe hosted origins `https://checkout.stripe.com` and `https://billing.stripe.com`. The service can redirect its own hosted page to another approved identity or billing provider without putting that provider's tokens in Sotto.

`status()` advances the device sign-in flow without blocking on a browser interaction. The application should refresh membership periodically and provide an explicit Refresh action. Codes expire, denied requests stay denied, and a slow-down response lengthens the next polling interval. The service must store only a hash of device secrets, use one-time approval/exchange, bind approval to the signed-in account, rate-limit code attempts and polling, and require the person to approve the visible desktop code. Account sessions and refresh/reauthentication policy remain server responsibilities.

## Entitlement and recovery

The desktop encrypts its origin-bound session and verified entitlement cache using the existing OS credential vault. Cache records bind to a fingerprint of that session, so changing accounts or endpoints cannot reuse another membership's access. No access token is returned to a renderer.

An active response requires a future expiry. The effective desktop lease ends at the earliest of the membership expiry, service `cacheUntil`, account-session expiry, or 24 hours after verification. **Twenty-four hours is a provisional beta ceiling**, not an approved production grace policy. The service may issue shorter leases. A clock rollback invalidates a cache beyond a one-minute tolerance. An authentication rejection clears cached access; an expired or missing cache cannot authorize actions during an outage. A persistence failure cannot restore a revoked entitlement.

The controller must check `expiresAt` before every paid action and automatic follow-up, even if the last displayed status was active. A lapse prevents new Sotto actions; it never sends cancellation to an agent already running in T3. Renewal refreshes access from the service. Scheduled cancellation is displayed with the paid-through date, and effective cancellation removes paid access.

## Stripe reference integration

If Stripe is selected, the server creates a subscription Checkout Session using its own configured Price ID and authenticated account/customer mapping. It creates customer-portal sessions on demand for that mapped customer. Browser success redirects do not grant membership. [Stripe hosted Checkout](https://docs.stripe.com/checkout/quickstart), [customer portal integration](https://docs.stripe.com/customer-management/integrate-customer-portal)

Verified webhook events update the server's entitlement records. Verify the signature against the raw request body, deduplicate event IDs, and handle repeated/out-of-order deliveries by reconciling with authoritative subscription state. Renewal, payment failures, and effective cancellation must update access before the desktop receives a new lease. [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks), [webhook delivery behavior](https://docs.stripe.com/webhooks), [webhook signature verification](https://docs.stripe.com/webhooks/signature)

## Required before paid launch

Select the identity provider, billing service, product price, entitlement validity/grace policy, and service domain. Implement the above endpoints and hosted account pages with an account-to-customer mapping. Configure service-only payment keys and a webhook signing secret, register the webhook, deploy, and validate with the provider's test environment. Exercise purchase, renewal, cancellation, authentication expiry, webhook replay/out-of-order delivery, service outage, and desktop lease expiry. Only then enable the production endpoint in packaged builds. No purchase, deployment, or external account changes were made while implementing the client.

## Automated client evidence

The focused membership/security contract tests exercise the actual client, credential repository, settings migration, and atomic filesystem storage. Only external HTTP responses, browser launching, time, and the OS encryption effect are controlled. They cover device authentication and backoff, browser-origin checks, checkout without entitlement, encrypted persistence, account/origin binding, renewal/cancellation, offline recovery and expiry, authentication revocation, clock rollback, concurrent credential slots, formatting-key redaction, and locked-store migration retry. A failing regression exposed stale active-cache recovery after revocation and a temporary encryption failure; cache invalidation now prevents that recovery.

These tests do not validate real operating-system cryptography, a deployed identity service, Stripe webhook handling, or an actual purchase. A failed migration deliberately preserves the old key for retry while keeping it out of renderer responses; after successful migration, the settings file contains no plaintext formatting key.
