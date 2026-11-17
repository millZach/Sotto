# Hermes threads use the ChatGPT subscription

Accepted November 17, 2026. Zach chose the inline ChatGPT row (prototype A), support on this computer and paired hosts, and stable for this feature.

Hermes already knows how to sign in to ChatGPT and use the subscription. Sotto runs Hermes with its own home on each computer, with profiles for projects. The host that runs the thread runs Hermes's own device-code sign-in. Its credential belongs to Sotto's Hermes home on that computer. Project profiles use Hermes's built-in root credential lookup and refresh. No token is copied between computers or out of a user's standalone Hermes or Codex.

Settings uses the existing provider sign-in dialog. The Hermes model list includes the ChatGPT models Hermes reports in its own catalog, and saved model server choices retain their identities. A ChatGPT model uses Hermes's native `openai-codex` route directly. A missing sign-in must stop that turn before its prompt is sent.

The host protocol advertises Hermes only to clients that declare they understand the provider. This extends ADR-0037's device-code flow to Hermes and keeps ADR-0124's model server route separate. Hermes contacts `auth.openai.com` for sign-in and `chatgpt.com` for the OpenAI model catalog and requests, as described in the README.
