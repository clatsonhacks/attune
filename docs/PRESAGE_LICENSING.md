# Presage SmartSpectra — licensing questions for distributing Attune

**Status:** to send (19–20 Nov 2026). Today each person running Attune needs their own SmartSpectra API key from
https://physiology.presagetech.com. For development and connector testing we use one developer key from `.env`. The
desktop app's first-run setup asks every user for **their own** key and stores it encrypted on their computer.

We want to know whether Presage offers a way to distribute an app so end users don't each need a developer key.

## Questions

1. **Distribution model.** Can a desktop app (Electron, Windows first, macOS later) be distributed to end users under
   one publisher licence or key? If yes, how are keys issued and protected (per install, per user, short-lived tokens)?
2. **Embedding keys.** Is it allowed to ship a key inside a desktop app? (We assume not — it can be extracted.)
3. **End-user accounts.** If every user needs their own key, is there a simpler consumer sign-up or an OAuth-style
   sign-in we can link to from the app instead of a developer portal?
4. **Pricing and limits.** Pricing tiers, per-user or per-minute limits, and what happens when a limit is reached.
5. **Automatic Insights.** Can automatic Insights be turned off while keeping on-device metrics? We disclose that
   Insights send buffered measurements to Presage; an off switch would let privacy-minded users opt out.
6. **Data handling.** What exactly is sent to Presage during sign-in, metrics and Insights; retention; region; whether
   data is used for training; a DPA for EU users.
7. **Store distribution.** Any restrictions on distributing through the Microsoft Store / Mac App Store?
8. **Disclosure wording.** Would Presage review our consent text (see the consent dialog in `web/index.html`)?
9. **Offline.** Does measurement work offline after sign-in, or does every session need the network?

## Draft email

> Subject: Licensing SmartSpectra for a desktop wellbeing companion (Attune)
>
> Hello Presage team,
>
> I'm building Attune, a local desktop app that uses the SmartSpectra Node SDK (3.5.0) to give AI assistants a
> privacy-first, interpreted sense of how the user is doing (for example, slowing down when someone seems tense, or
> pacing breath during yoga). Video stays on the device; only interpreted, number-free guidance is shared with the AI
> the user chooses, and only with their consent.
>
> Before we release it, could you help with a few questions?
>
> 1. Can a desktop app be distributed to end users under a single publisher licence, or does every user need their
>    own API key? If per-user, is there a consumer-friendly sign-up or sign-in we can link to?
> 2. What are the pricing tiers and usage limits for this kind of distribution?
> 3. Can automatic Insights be disabled while keeping on-device metrics?
> 4. What data is sent to Presage during sign-in, metrics and Insights, how long is it kept, and is a DPA available?
> 5. Are there restrictions on Microsoft Store or Mac App Store distribution?
>
> Happy to share more details or a demo.
>
> Thanks,
> [Your name]
> [Contact]

## What changes depending on the answer

| Answer | What Attune does |
|---|---|
| Per-user keys only | Keep the guided "enter your key" step in first-run setup (with a link and a 2-minute walkthrough). |
| Publisher licence with per-install tokens | Replace the key step with sign-in; never store a long-lived shared key on devices. |
| Insights can be disabled | Add an "Insights" switch to the consent dialog and default it off. |
